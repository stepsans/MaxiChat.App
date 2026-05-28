import { Router } from "express";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, channelsTable } from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { loadOwnedChannel, listOwnedChannels } from "../lib/channel-context";
import { requireSuperAdmin } from "../lib/team-permissions";

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

// NOTE: DELETE intentionally not exposed in this pass. Per architect
// finding #3, deleting a channel must also: logout the Baileys socket,
// wipe the per-channel auth dir, and cascade clean up chats/messages.
// That work lands together with the runtime re-key from userCtxs →
// channelCtxs. Until then, channels are effectively immortal.

export default router;
