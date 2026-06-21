import { Router } from "express";
import { db } from "@workspace/db";
import { tenantSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateGeneralSettingsBody, UpdateAutoReplyBody } from "@workspace/api-zod";
import { settingsTable } from "@workspace/db";
import { requireSuperAdmin } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import { requireOwnedChannelLoose } from "../lib/channel-context";
import {
  getOrCreateChannelSettings,
  getOrCreateTenantSettings,
  getMergedSettings,
} from "../lib/settings-store";

const router = Router();

// GET returns the merged tenant+channel settings consumed only by the AI Studio
// page, so it is gated on aiStudio.view (super_admin + supervisor by default;
// agents are excluded). The merged view works for unpaired channels too —
// per-channel rows key on channel.id and the tenant general row keys on
// channel.userId, neither needs ownerPhone.
router.get("/", requirePermission("aiStudio", "view"), async (req, res): Promise<void> => {
  try {
    const channel = await requireOwnedChannelLoose(req, res);
    if (!channel) return;
    const merged = await getMergedSettings(channel);
    res.json(merged);
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Business-wide ("general") settings — only super admins may edit. Applies to
// the whole tenant (all channels), keyed on the effective owner user id.
router.put("/general", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const parsed = UpdateGeneralSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const channel = await requireOwnedChannelLoose(req, res);
    if (!channel) return;

    // Ensure a tenant row exists, then update it for this owner.
    const current = await getOrCreateTenantSettings(channel.userId);

    // A hand-edit of the persona in AI Studio marks the prompt as 'manual' (so the
    // wizard asks before overwriting) and snapshots the old text for single-step
    // undo ("Kembalikan versi sebelumnya"). Lapis C guardrails are not stored here,
    // so they can never be edited away through this path.
    const patch: Partial<typeof tenantSettingsTable.$inferInsert> = {
      ...parsed.data,
      updatedAt: new Date(),
    };
    if (parsed.data.systemPrompt !== undefined && parsed.data.systemPrompt !== current.systemPrompt) {
      patch.aiPromptSource = "manual";
      patch.systemPromptPrevious = current.systemPrompt;
    }
    await db
      .update(tenantSettingsTable)
      .set(patch)
      .where(eq(tenantSettingsTable.ownerUserId, channel.userId));

    res.json(await getMergedSettings(channel));
  } catch (err) {
    req.log.error({ err }, "Failed to update general settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Single-step "Kembalikan versi sebelumnya" — swap system_prompt with the
// snapshot taken before the last overwrite (wizard save or manual edit). Marks
// the restored prompt 'manual' since it is now an explicit owner choice.
router.post("/restore-previous", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const channel = await requireOwnedChannelLoose(req, res);
    if (!channel) return;
    const current = await getOrCreateTenantSettings(channel.userId);
    if (!current.systemPromptPrevious) {
      res.status(400).json({ error: "Tidak ada versi sebelumnya untuk dikembalikan." });
      return;
    }
    await db
      .update(tenantSettingsTable)
      .set({
        systemPrompt: current.systemPromptPrevious,
        // Swap so a second click toggles back (and clears once consumed below).
        systemPromptPrevious: current.systemPrompt,
        aiPromptSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(tenantSettingsTable.ownerUserId, channel.userId));
    res.json(await getMergedSettings(channel));
  } catch (err) {
    req.log.error({ err }, "Failed to restore previous prompt");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Per-channel AI auto-reply toggle — lives on the AI Studio page, so it is
// gated on aiStudio.view (matching GET): anyone who can see AI Studio for the
// active channel may flip this for their own number.
router.put("/auto-reply", requirePermission("aiStudio", "view"), async (req, res): Promise<void> => {
  try {
    const parsed = UpdateAutoReplyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const channel = await requireOwnedChannelLoose(req, res);
    if (!channel) return;
    if (!channel.ownerPhone) {
      res
        .status(503)
        .json({ error: "WhatsApp belum terhubung untuk channel ini." });
      return;
    }

    const current = await getOrCreateChannelSettings(channel);
    await db
      .update(settingsTable)
      .set({ autoReplyEnabled: parsed.data.autoReplyEnabled, updatedAt: new Date() })
      .where(eq(settingsTable.id, current.id));

    res.json(await getMergedSettings(channel));
  } catch (err) {
    req.log.error({ err }, "Failed to update auto-reply");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
