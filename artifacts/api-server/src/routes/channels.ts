import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  chatsTable,
  whatsappStatusesTable,
  settingsTable,
  chatbotFlowsTable,
} from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { loadOwnedChannel, listOwnedChannels } from "../lib/channel-context";
import { requireSuperAdmin } from "../lib/team-permissions";
import {
  startBaileysForChannel,
  disconnectChannelRuntime,
} from "./whatsapp";

const router = Router();

// Phase 1 only exposes WhatsApp to the create endpoint. Other kinds are
// accepted by the DB schema (free-form text) so future migrations can
// land without altering the column, but the API layer gates which ones
// users can actually create until each kind has runtime support.
const CHANNEL_KINDS = [
  "whatsapp",
  "instagram",
  "facebook",
  "tiktok_shop",
  "shopee",
  "webchat",
  "line",
  "telegram",
] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];
const CREATABLE_KINDS: ReadonlySet<ChannelKind> = new Set(["whatsapp"]);

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const ChannelCreateBody = z.object({
  kind: z.enum(CHANNEL_KINDS),
  label: z.string().trim().min(1).max(60),
  color: z.string().regex(HEX_COLOR).optional(),
  icon: z.string().trim().min(1).max(40).optional(),
});

const ChannelUpdateBody = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
  icon: z.string().trim().min(1).max(40).optional(),
});

function serialize(c: typeof channelsTable.$inferSelect) {
  return {
    id: c.id,
    userId: c.userId,
    kind: c.kind,
    label: c.label,
    color: c.color,
    icon: c.icon,
    status: c.status,
    ownerPhone: c.ownerPhone,
    metadata: c.metadata ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// GET /channels — list every channel for the owning account.
// Visible to all team roles so invited agents can see/switch the same
// dropdown the super_admin sees.
router.get("/", async (req, res): Promise<void> => {
  try {
    const rows = await listOwnedChannels(req);
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "list channels failed");
    res.status(500).json({ error: "Failed to list channels" });
  }
});

// GET /channels/:id
router.get("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const row = await loadOwnedChannel(req, id);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    res.json(serialize(row));
  } catch (err) {
    req.log.error({ err, id }, "get channel failed");
    res.status(500).json({ error: "Failed to load channel" });
  }
});

// POST /channels — create a new channel row. Phase 1: WhatsApp only; the
// row starts as `disconnected` and pairing happens via a separate flow
// (see T008 wizard / Baileys runtime). super_admin-only — supervisors and
// agents can switch between channels but can't add new ones.
router.post("/", requireSuperAdmin, async (req, res): Promise<void> => {
  const parsed = ChannelCreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!CREATABLE_KINDS.has(parsed.data.kind)) {
    res.status(400).json({
      error: `Channel kind "${parsed.data.kind}" belum tersedia. Saat ini hanya WhatsApp yang aktif.`,
    });
    return;
  }
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  try {
    const ownerUid = await getEffectiveOwnerUserId(uid);
    const [row] = await db
      .insert(channelsTable)
      .values({
        userId: ownerUid,
        kind: parsed.data.kind,
        label: parsed.data.label.trim(),
        color: parsed.data.color ?? "#25D366",
        icon: parsed.data.icon?.trim() ?? parsed.data.kind,
        status: "disconnected",
      })
      .returning();
    res.status(201).json(serialize(row));
  } catch (err: unknown) {
    // Unique violation on (user_id, label) — friendly error so the UI can
    // surface it on the form.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Sudah ada channel dengan label tersebut" });
      return;
    }
    req.log.error({ err }, "create channel failed");
    res.status(500).json({ error: "Failed to create channel" });
  }
});

// PATCH /channels/:id — rename / change color / change icon. Does NOT touch
// status, ownerPhone, kind, or metadata — those are managed by the Baileys
// runtime (status, ownerPhone) or are immutable post-create (kind).
router.patch("/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  const parsed = ChannelUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const patch = parsed.data;
  if (
    patch.label === undefined &&
    patch.color === undefined &&
    patch.icon === undefined
  ) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  try {
    const existing = await loadOwnedChannel(req, id);
    if (!existing) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const [row] = await db
      .update(channelsTable)
      .set({
        ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon.trim() } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(channelsTable.id, id))
      .returning();
    res.json(serialize(row));
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Sudah ada channel dengan label tersebut" });
      return;
    }
    req.log.error({ err, id }, "update channel failed");
    res.status(500).json({ error: "Failed to update channel" });
  }
});

// POST /channels/:id/pair — bring up the per-channel Baileys socket so a
// new WhatsApp number can be scanned. Status flips to "connecting"
// immediately; the QR data url appears on GET /channels/:id/qr a moment
// later (it's pushed asynchronously by the Baileys connection.update
// handler into channels.metadata.qrCode).
router.post("/:id/pair", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const existing = await loadOwnedChannel(req, id);
    if (!existing) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (existing.kind !== "whatsapp") {
      res.status(400).json({
        error: `Pairing belum tersedia untuk channel ${existing.kind}.`,
      });
      return;
    }
    if (existing.status === "connected") {
      res.json(serialize(existing));
      return;
    }
    // Clear any stale qrCode from a previous pair attempt so /qr can't
    // briefly serve last session's QR while the new Baileys socket spins up.
    await db
      .update(channelsTable)
      .set({
        status: "connecting",
        metadata: sql`COALESCE(${channelsTable.metadata}, '{}'::jsonb) - 'qrCode'`,
        updatedAt: new Date(),
      })
      .where(eq(channelsTable.id, id));
    // Fire-and-forget: Baileys QR generation is async and pushes status
    // into the channels row via syncChannelStatus.
    startBaileysForChannel(existing.userId, id).catch((err) =>
      req.log.error({ err, channelId: id }, "Baileys start failed")
    );
    const [refreshed] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, id));
    res.json(serialize(refreshed ?? existing));
  } catch (err) {
    req.log.error({ err, id }, "pair channel failed");
    res.status(500).json({ error: "Failed to start pairing" });
  }
});

// GET /channels/:id/qr — poll endpoint for the pairing UI. Returns the
// current status plus the QR data url (when status === "qr_ready"). The
// QR lives in channels.metadata.qrCode and is cleared on connect/close.
router.get("/:id/qr", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const row = await loadOwnedChannel(req, id);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const qrCode = typeof meta.qrCode === "string" ? meta.qrCode : null;
    res.json({
      status: row.status,
      qrCode,
      ownerPhone: row.ownerPhone,
    });
  } catch (err) {
    req.log.error({ err, id }, "get channel qr failed");
    res.status(500).json({ error: "Failed to load channel QR" });
  }
});

// POST /channels/:id/unpair — log the Baileys socket out and wipe the
// per-channel auth dir without deleting the channel row or any of its
// chats. The next /pair starts from a fresh QR.
router.post("/:id/unpair", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const existing = await loadOwnedChannel(req, id);
    if (!existing) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (existing.kind !== "whatsapp") {
      res.status(400).json({
        error: `Unpair belum tersedia untuk channel ${existing.kind}.`,
      });
      return;
    }
    await disconnectChannelRuntime(existing.userId, id);
    const [refreshed] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, id));
    res.json(serialize(refreshed ?? existing));
  } catch (err) {
    req.log.error({ err, id }, "unpair channel failed");
    res.status(500).json({ error: "Failed to unpair channel" });
  }
});

// DELETE /channels/:id — hard-delete a channel and every per-channel row
// (chats + messages cascading, statuses, settings, flows) belonging to
// it. We block deletion of the user's LAST channel because every
// back-compat surface (getPrimaryCtxForUser, primary-channel helpers)
// assumes the owner has at least one; Phase E removes that assumption.
router.delete("/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const existing = await loadOwnedChannel(req, id);
    if (!existing) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    // Block-last guard: every back-compat helper (getPrimaryCtxForUser,
    // ensurePrimaryWhatsappChannelForUser, the legacy /whatsapp/* routes)
    // assumes the owner has at least one WhatsApp channel. We therefore
    // gate ONLY on remaining WhatsApp siblings — having non-WA channels
    // (Instagram, Shopee, etc.) doesn't satisfy the invariant.
    if (existing.kind === "whatsapp") {
      const waSiblings = await db
        .select({ id: channelsTable.id })
        .from(channelsTable)
        .where(
          and(
            eq(channelsTable.userId, existing.userId),
            eq(channelsTable.kind, "whatsapp"),
            ne(channelsTable.id, id)
          )
        );
      if (waSiblings.length === 0) {
        res.status(400).json({
          error: "Tidak bisa menghapus channel WhatsApp terakhir. Tambahkan channel WhatsApp lain terlebih dahulu.",
        });
        return;
      }
    }
    // Tear down the live socket + wipe authDir first so no in-flight
    // handler races the row deletion.
    if (existing.kind === "whatsapp") {
      await disconnectChannelRuntime(existing.userId, id).catch((err) =>
        req.log.warn({ err, channelId: id }, "disconnect during delete failed (non-fatal)")
      );
    }
    // Per-channel rows are scoped purely by channel_id (T009 dropped the
    // legacy ownerPhone columns from these 4 tables). chat_messages
    // cascades off chats via FK so no separate sweep needed.
    await db.delete(chatsTable).where(eq(chatsTable.channelId, id));
    await db.delete(whatsappStatusesTable).where(eq(whatsappStatusesTable.channelId, id));
    await db.delete(settingsTable).where(eq(settingsTable.channelId, id));
    await db.delete(chatbotFlowsTable).where(eq(chatbotFlowsTable.channelId, id));
    // channel_products / channel_knowledge / channel_text_shortcuts join
    // tables cascade off channels via their own FKs, so the row delete
    // below also cleans those up.
    await db.delete(channelsTable).where(eq(channelsTable.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err, id }, "delete channel failed");
    res.status(500).json({ error: "Failed to delete channel" });
  }
});

export default router;
