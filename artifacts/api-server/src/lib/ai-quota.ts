import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  aiUsageEventsTable,
  tenantQuotaTable,
  plansTable,
} from "@workspace/db";
import { resolveBillingWindow } from "./tenant-window";
import { getEffectiveSubscription } from "./billing";
import { isInfinityOwner } from "./infinity-owner";
import { getActiveBoosterState } from "./token-boosters";
import {
  computeUsagePercent,
  computeNotifyLevel,
  computeProjectedDaysRemaining,
  type NotifyLevel,
} from "./ai-usage-build";

// The complete two-bucket quota picture for an owner — the SINGLE computation
// shared by the Pemakaian Token endpoint (display), the resolveAiClient
// hard-block (enforcement), and the threshold notifier. Computing it in one
// place keeps display, gating, and alerts from ever disagreeing.
export interface OwnerTokenQuota {
  ownerUserId: number;
  email: string;
  name: string | null;
  joinedAt: Date;
  planName: string;
  isTrial: boolean;
  isInfinity: boolean;
  periodStart: Date;
  periodEnd: Date;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  grantLimit: number;
  grantRemaining: number;
  boosterRemaining: number;
  boosterNextExpiresAt: Date | null;
  boosters: { amount: number; remaining: number; expiresAt: Date }[];
  tokenUsed: number;
  tokenLimit: number;
  tokenRemaining: number;
  usagePercent: number;
  notifyLevel: NotifyLevel;
  projectedDaysRemaining: number | null;
  // True when the plafon is exhausted AND enforced — the AI hard-block fires.
  // Never true for infinity owners or uncapped (unprovisioned, tokenLimit 0).
  blocked: boolean;
}

export async function getOwnerTokenQuota(
  ownerUserId: number,
  now: Date = new Date()
): Promise<OwnerTokenQuota | null> {
  const [owner] = await db
    .select({
      createdAt: usersTable.createdAt,
      email: usersTable.email,
      name: usersTable.name,
      plan: usersTable.plan,
    })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);
  if (!owner) return null;

  const [quota] = await db
    .select({
      periodStart: tenantQuotaTable.periodStart,
      periodEnd: tenantQuotaTable.periodEnd,
      anchorDate: tenantQuotaTable.anchorDate,
      tokenLimit: tenantQuotaTable.tokenLimit,
      planName: plansTable.name,
    })
    .from(tenantQuotaTable)
    .leftJoin(plansTable, eq(tenantQuotaTable.planId, plansTable.id))
    .where(eq(tenantQuotaTable.userId, ownerUserId))
    .limit(1);

  const { start, end } = resolveBillingWindow(quota, owner.createdAt, now);

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

  const [infinity, sub, boosterState] = await Promise.all([
    isInfinityOwner(ownerUserId),
    getEffectiveSubscription(ownerUserId),
    getActiveBoosterState(ownerUserId, now),
  ]);

  const promptTokens = agg?.promptTokens ?? 0;
  const completionTokens = agg?.completionTokens ?? 0;
  const totalTokens = agg?.totalTokens ?? 0;
  const requestCount = agg?.requestCount ?? 0;
  const isTrial = !infinity && sub.effectiveStatus === "trial";

  const grantLimit = infinity ? 0 : quota?.tokenLimit ?? 0;
  const boosterRemaining = infinity ? 0 : boosterState.boosterRemaining;
  const tokenUsed = totalTokens;
  // Grant is computed live; booster is an already-decremented stored counter.
  const grantRemaining = Math.max(0, grantLimit - tokenUsed);
  const tokenRemaining = grantRemaining + boosterRemaining;
  // tokenLimit 0 = uncapped (infinity / unprovisioned); helpers read it as "no
  // cap". Otherwise a stable plafon = used + remaining.
  const uncapped = grantLimit <= 0 && boosterRemaining <= 0;
  const tokenLimit = uncapped ? 0 : tokenUsed + tokenRemaining;

  const planName = infinity
    ? "Infinity"
    : isTrial
      ? "Trial"
      : quota?.planName ??
        owner.plan.charAt(0).toUpperCase() + owner.plan.slice(1);

  return {
    ownerUserId,
    email: owner.email,
    name: owner.name ?? null,
    joinedAt: owner.createdAt,
    planName,
    isTrial,
    isInfinity: infinity,
    periodStart: start,
    periodEnd: end,
    promptTokens,
    completionTokens,
    totalTokens,
    requestCount,
    grantLimit,
    grantRemaining,
    boosterRemaining,
    boosterNextExpiresAt: boosterState.nextExpiresAt,
    boosters: boosterState.boosters,
    tokenUsed,
    tokenLimit,
    tokenRemaining,
    usagePercent: computeUsagePercent(tokenLimit, tokenUsed),
    notifyLevel: computeNotifyLevel(tokenLimit, tokenUsed),
    projectedDaysRemaining: computeProjectedDaysRemaining({
      tokenLimit,
      tokenUsed,
      periodStart: start,
      now,
    }),
    // Enforced depletion: capped (not uncapped/infinity) and nothing left.
    blocked: !infinity && !uncapped && tokenRemaining <= 0,
  };
}

// Thrown by resolveAiClient when the owner's token plafon is exhausted (spec
// C1). A distinct class so callers can tell a hard-block apart from a transient
// failure: auto-reply paths fall back to the static message, background jobs
// defer, request handlers map it to HTTP 402.
export class TokenQuotaExceededError extends Error {
  readonly ownerUserId: number;
  constructor(ownerUserId: number) {
    super("AI token quota exhausted for this tenant");
    this.name = "TokenQuotaExceededError";
    this.ownerUserId = ownerUserId;
  }
}

// Cheap-ish enforcement check used inside resolveAiClient. Returns true when the
// NEXT AI call must be blocked. Best-effort: on any error it returns false (fail
// OPEN — a metering glitch must never wrongly silence a paying tenant's AI).
export async function isOwnerTokenBlocked(
  ownerUserId: number,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const q = await getOwnerTokenQuota(ownerUserId, now);
    return q?.blocked ?? false;
  } catch {
    return false;
  }
}
