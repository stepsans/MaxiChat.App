import { Router } from "express";
import { db } from "@workspace/db";
import { channelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveChannelScope } from "../lib/channel-context";
import { requirePermission } from "../lib/role-permissions";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  computeAnalyticsSummary,
  computeCommonQuestions,
  computeStorageUsage,
} from "../lib/analytics-queries";

const router = Router();

// Every analytics endpoint is read-only aggregation, so all of them are
// gated by analytics.canView.
router.use(requirePermission("analytics", "view"));

router.get("/summary", async (req, res): Promise<void> => {
  try {
    // Per-phone isolation: when disconnected, every counter is zero — the
    // dashboard for "nobody logged in" must not show another account's
    // numbers. Once a phone connects, only its own data is aggregated.
    const scope = await resolveChannelScope(req, res);
    if (!scope) return;
    res.json(await computeAnalyticsSummary(scope.channelIds));
  } catch (err) {
    req.log.error({ err }, "Failed to get analytics summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/common-questions", async (req, res): Promise<void> => {
  try {
    // Scope keyword counting to the current account's inbound messages only.
    const scope = await resolveChannelScope(req, res);
    if (!scope) return;
    res.json(await computeCommonQuestions(scope.channelIds));
  } catch (err) {
    req.log.error({ err }, "Failed to get common questions");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Tenant-wide chat data usage (every channel the owner has), independent of
// the channel switcher — this answers "how much chat data does this super
// admin store". Estimated bytes use pg_column_size over the actual rows so the
// figure tracks real on-disk footprint of chats + their messages.
router.get("/storage", async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const channels = await db
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(eq(channelsTable.userId, ownerId));
    res.json(await computeStorageUsage(channels.map((c) => c.id)));
  } catch (err) {
    req.log.error({ err }, "Failed to get storage usage");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
