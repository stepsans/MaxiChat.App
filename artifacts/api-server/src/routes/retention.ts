import { Router } from "express";
import { db, retentionSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateRetentionBody } from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requireSuperAdmin } from "../lib/team-permissions";
import {
  getRetentionPolicy,
  getPlanRetentionCap,
  clampPolicy,
} from "../lib/retention";

const router = Router();

// Return the caller tenant's retention policy + the plan cap.
router.get("/", async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const [policy, planLimitDays] = await Promise.all([
      getRetentionPolicy(ownerId),
      getPlanRetentionCap(ownerId),
    ]);
    res.json({ ...policy, planLimitDays });
  } catch (err) {
    req.log.error({ err }, "getRetention failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update the retention policy. Super admin only. Each value is clamped to the
// active plan's retention cap server-side (a tenant may keep data for shorter
// than the cap, never longer).
router.put("/", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const parsed = UpdateRetentionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const cap = await getPlanRetentionCap(ownerId);
    const chosen = {
      chatDays: parsed.data.chatDays ?? null,
      mediaDays: parsed.data.mediaDays ?? null,
      logDays: parsed.data.logDays ?? null,
      analyticsDays: parsed.data.analyticsDays ?? null,
    };
    const clamped = clampPolicy(chosen, cap);

    await db
      .insert(retentionSettingsTable)
      .values({ userId: ownerId, ...clamped })
      .onConflictDoUpdate({
        target: retentionSettingsTable.userId,
        set: { ...clamped, updatedAt: new Date() },
      });

    res.json({ ...clamped, planLimitDays: cap });
  } catch (err) {
    req.log.error({ err }, "updateRetention failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
