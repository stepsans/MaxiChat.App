import { Router } from "express";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, usersTable, aiUsageEventsTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { computeBillingPeriod } from "../lib/billing-period";

const router = Router();

// GET /ai-usage/me — the signed-in user's OWN tenant AI token usage for the
// current billing period (anchored on the owner's join date). Restricted to the
// tenant owner (super_admin): an invited supervisor/agent would otherwise see
// tenant-wide spend that isn't theirs to manage.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    if (ownerUserId !== userId) {
      res
        .status(403)
        .json({ error: "Hanya super admin yang dapat melihat pemakaian token" });
      return;
    }

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
