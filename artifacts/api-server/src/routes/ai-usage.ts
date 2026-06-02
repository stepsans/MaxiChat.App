import { Router } from "express";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, usersTable, aiUsageEventsTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { computeBillingPeriod } from "../lib/billing-period";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// Pemakaian Token is a view-only matrix menu (usage.view). By default only the
// tenant owner (super_admin) has it; a super_admin may grant supervisors/agents
// read access. Either way the figures shown are the OWNER's tenant-wide spend.
router.use(requirePermission("usage", "view"));

// GET /ai-usage/me — the owner's tenant AI token usage for the current billing
// period (anchored on the owner's join date). The aggregate is always the
// tenant owner's spend, regardless of which permitted team member is viewing.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const [owner] = await db
      .select({ createdAt: usersTable.createdAt, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);
    if (!owner) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    const now = new Date();
    const { start, end } = computeBillingPeriod(owner.createdAt, now);
    const [agg] = await db
      .select({
        promptTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.promptTokens}),0)::int`,
        completionTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.completionTokens}),0)::int`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.totalTokens}),0)::int`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageEventsTable)
      .where(
        and(
          eq(aiUsageEventsTable.userId, ownerUserId),
          gte(aiUsageEventsTable.createdAt, start),
          lt(aiUsageEventsTable.createdAt, end)
        )
      );

    res.json({
      userId: ownerUserId,
      email: owner.email,
      joinedAt: owner.createdAt.toISOString(),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      promptTokens: agg?.promptTokens ?? 0,
      completionTokens: agg?.completionTokens ?? 0,
      totalTokens: agg?.totalTokens ?? 0,
      requestCount: agg?.requestCount ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "aiUsageMe failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
