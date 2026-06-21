import { Router } from "express";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  aiUsageEventsTable,
  tenantQuotaTable,
  channelsTable,
} from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { resolveBillingWindow } from "../lib/tenant-window";
import { getOwnerTokenQuota } from "../lib/ai-quota";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// Pemakaian Token is a view-only matrix menu (usage.view). By default only the
// tenant owner (super_admin) has it; a super_admin may grant supervisors/agents
// read access. Either way the figures shown are the OWNER's tenant-wide spend.
router.use(requirePermission("usage", "view"));

// GET /ai-usage/me — the owner's tenant AI token usage plus quota context for
// the current billing period. The window comes from tenant_quota; the aggregate
// is always the tenant owner's spend, regardless of which permitted team member
// is viewing.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const q = await getOwnerTokenQuota(ownerUserId);
    if (!q) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    res.json({
      userId: q.ownerUserId,
      email: q.email,
      name: q.name,
      joinedAt: q.joinedAt.toISOString(),
      periodStart: q.periodStart.toISOString(),
      periodEnd: q.periodEnd.toISOString(),
      promptTokens: q.promptTokens,
      completionTokens: q.completionTokens,
      totalTokens: q.totalTokens,
      requestCount: q.requestCount,
      planName: q.planName,
      isTrial: q.isTrial,
      isInfinity: q.isInfinity,
      tokenLimit: q.tokenLimit,
      tokenUsed: q.tokenUsed,
      tokenRemaining: q.tokenRemaining,
      usagePercent: q.usagePercent,
      grantLimit: q.grantLimit,
      grantRemaining: q.grantRemaining,
      grantResetAt: q.periodEnd.toISOString(),
      boosterRemaining: q.boosterRemaining,
      boosterNextExpiresAt: q.boosterNextExpiresAt
        ? q.boosterNextExpiresAt.toISOString()
        : null,
      boosters: q.boosters.map((b) => ({
        amount: b.amount,
        remaining: b.remaining,
        expiresAt: b.expiresAt.toISOString(),
      })),
      notifyLevel: q.notifyLevel,
      projectedDaysRemaining: q.projectedDaysRemaining,
    });
  } catch (err) {
    req.log.error({ err }, "aiUsageMe failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ai-usage/me/by-channel — the owner's token spend in the current period
// grouped per channel. Powers the channel filter and the "which channel burns
// the most" diagnostic. channelId is nullable (history is preserved even after a
// channel is deleted), so usage with no resolvable channel rolls into one row.
router.get("/me/by-channel", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const [owner] = await db
      .select({ createdAt: usersTable.createdAt })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);
    if (!owner) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }

    const [quota] = await db
      .select({
        periodStart: tenantQuotaTable.periodStart,
        periodEnd: tenantQuotaTable.periodEnd,
      })
      .from(tenantQuotaTable)
      .where(eq(tenantQuotaTable.userId, ownerUserId))
      .limit(1);

    const { start, end } = resolveBillingWindow(quota, owner.createdAt, new Date());

    const rows = await db
      .select({
        channelId: aiUsageEventsTable.channelId,
        channelName: channelsTable.label,
        channelType: channelsTable.kind,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.totalTokens}),0)::int`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageEventsTable)
      .leftJoin(channelsTable, eq(aiUsageEventsTable.channelId, channelsTable.id))
      .where(
        and(
          eq(aiUsageEventsTable.userId, ownerUserId),
          gte(aiUsageEventsTable.createdAt, start),
          lt(aiUsageEventsTable.createdAt, end)
        )
      )
      .groupBy(
        aiUsageEventsTable.channelId,
        channelsTable.label,
        channelsTable.kind
      );

    res.json(
      rows.map((r) => ({
        channelId: r.channelId,
        channelName: r.channelName ?? "Tanpa channel",
        channelType: r.channelType ?? "unknown",
        totalTokens: r.totalTokens ?? 0,
        requestCount: r.requestCount ?? 0,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "aiUsageByChannel failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ai-usage/me/daily?days=30 — the owner's daily token totals over a
// trailing window, for the usage-trend chart. Oldest first.
router.get("/me/daily", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const rawDays = Number(req.query.days);
    const days =
      Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 90 ? rawDays : 30;
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${aiUsageEventsTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        totalTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.totalTokens}),0)::int`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageEventsTable)
      .where(
        and(
          eq(aiUsageEventsTable.userId, ownerUserId),
          gte(aiUsageEventsTable.createdAt, start)
        )
      )
      .groupBy(
        sql`date_trunc('day', ${aiUsageEventsTable.createdAt} AT TIME ZONE 'UTC')`
      )
      .orderBy(
        sql`date_trunc('day', ${aiUsageEventsTable.createdAt} AT TIME ZONE 'UTC')`
      );

    res.json(
      rows.map((r) => ({
        date: r.date,
        totalTokens: r.totalTokens ?? 0,
        requestCount: r.requestCount ?? 0,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "aiUsageDaily failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
