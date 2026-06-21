import { and, eq, gt, gte, lt, sql, asc } from "drizzle-orm";
import {
  db,
  tokenBoostersTable,
  tenantQuotaTable,
  aiUsageEventsTable,
} from "@workspace/db";
import { logger } from "./logger";

// Accepts either the root db handle or a transaction handle, so the purchase
// path can grant a booster INSIDE settlePaymentPaid's atomic settlement.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Paid token boosters expire 90 days after purchase (LOCKED spec B2).
export const BOOSTER_TTL_DAYS = 90;

// Create a paid booster (Ember B) — the settlement path's way to provision a
// 'token' add-on as a 90-day, period-spanning bucket rather than a grant top-up.
// Pass the settlement transaction as `exec` so the row is atomic with the
// pending→paid flip (a later failure rolls the booster back too).
export async function grantBooster(
  args: { ownerUserId: number; amountTokens: number; now?: Date },
  exec: DbExecutor = db
): Promise<void> {
  const now = args.now ?? new Date();
  if (args.amountTokens <= 0) return;
  const expiresAt = new Date(
    now.getTime() + BOOSTER_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  await exec.insert(tokenBoostersTable).values({
    ownerUserId: args.ownerUserId,
    amountTokens: args.amountTokens,
    remainingTokens: args.amountTokens,
    purchasedAt: now,
    expiresAt,
    status: "active",
  });
}
import { getOwnerBillingWindow } from "./tenant-window";
import {
  planBoosterConsumption,
  boosterOverflowForCharge,
  type BoosterLike,
} from "./booster-consume";

export interface ActiveBoosterState {
  // Sum of remainingTokens across all spendable (active, unexpired) boosters.
  boosterRemaining: number;
  // Soonest expiry among spendable boosters, or null when there are none.
  nextExpiresAt: Date | null;
  // Per-booster breakdown for the detailed quota view (soonest expiry first).
  boosters: { amount: number; remaining: number; expiresAt: Date }[];
}

// Spendable = active status, still has tokens, not past expiry. One source of
// truth for the read side (display) and the consume side (FIFO order).
function spendableWhere(ownerUserId: number, now: Date) {
  return and(
    eq(tokenBoostersTable.ownerUserId, ownerUserId),
    eq(tokenBoostersTable.status, "active"),
    gt(tokenBoostersTable.remainingTokens, 0),
    gt(tokenBoostersTable.expiresAt, now)
  );
}

export async function getActiveBoosterState(
  ownerUserId: number,
  now: Date = new Date()
): Promise<ActiveBoosterState> {
  const rows = await db
    .select({
      amount: tokenBoostersTable.amountTokens,
      remaining: tokenBoostersTable.remainingTokens,
      expiresAt: tokenBoostersTable.expiresAt,
    })
    .from(tokenBoostersTable)
    .where(spendableWhere(ownerUserId, now))
    .orderBy(asc(tokenBoostersTable.expiresAt));

  const boosterRemaining = rows.reduce((sum, r) => sum + r.remaining, 0);
  const nextExpiresAt = rows.length > 0 ? rows[0]!.expiresAt : null;
  return { boosterRemaining, nextExpiresAt, boosters: rows };
}

// Decrement boosters for the portion of a just-recorded charge that overflows
// past the monthly grant (LOCKED spec B3). Best-effort: never throws — token
// metering must never break a customer reply. Called AFTER the usage row is
// inserted, so the period SUM already includes this charge.
//
// Concurrency note: this is metering, not financial settlement, so a rare
// double-read under concurrent charges (slightly under-debiting a booster) is
// acceptable; the Step 4 hard-block is the real spend gate.
export async function consumeBoosterOverflow(
  ownerUserId: number,
  chargeTokens: number,
  now: Date = new Date()
): Promise<void> {
  try {
    if (chargeTokens <= 0) return;

    // Cheap early exit (indexed): the vast majority of owners hold no boosters,
    // and an owner with none has nothing to decrement. Skipping here also avoids
    // spurious "unmet overflow" warnings for unprovisioned/trial tenants whose
    // grant is 0 — their gating is the Step 4 hard-block, not this metering.
    const [firstBooster] = await db
      .select({ id: tokenBoostersTable.id })
      .from(tokenBoostersTable)
      .where(spendableWhere(ownerUserId, now))
      .limit(1);
    if (!firstBooster) return;

    const [quota] = await db
      .select({ tokenLimit: tenantQuotaTable.tokenLimit })
      .from(tenantQuotaTable)
      .where(eq(tenantQuotaTable.userId, ownerUserId))
      .limit(1);
    const grantLimit = quota?.tokenLimit ?? 0;

    const window = await getOwnerBillingWindow(ownerUserId, now);
    if (!window) return;

    // Period usage INCLUDING this charge (the row is already inserted), so
    // usage-before = total - thisCharge.
    const [agg] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${aiUsageEventsTable.totalTokens}),0)::int`,
      })
      .from(aiUsageEventsTable)
      .where(
        and(
          eq(aiUsageEventsTable.userId, ownerUserId),
          gte(aiUsageEventsTable.createdAt, window.start),
          lt(aiUsageEventsTable.createdAt, window.end)
        )
      );
    const usageAfter = agg?.total ?? 0;
    const usageBeforeCharge = Math.max(0, usageAfter - chargeTokens);

    const overflow = boosterOverflowForCharge({
      grantLimit,
      usageBeforeCharge,
      chargeTokens,
    });
    if (overflow <= 0) return;

    const rows = await db
      .select({
        id: tokenBoostersTable.id,
        remainingTokens: tokenBoostersTable.remainingTokens,
        expiresAt: tokenBoostersTable.expiresAt,
      })
      .from(tokenBoostersTable)
      .where(spendableWhere(ownerUserId, now))
      .orderBy(asc(tokenBoostersTable.expiresAt));

    const { decrements, unmet } = planBoosterConsumption(
      overflow,
      rows as BoosterLike[]
    );
    if (unmet > 0) {
      logger.warn(
        { ownerUserId, overflow, unmet },
        "booster overflow exceeded available boosters (grant+booster depleted)"
      );
    }

    for (const d of decrements) {
      await db
        .update(tokenBoostersTable)
        .set({
          remainingTokens: d.newRemaining,
          status: d.newRemaining <= 0 ? "depleted" : "active",
          updatedAt: now,
        })
        .where(eq(tokenBoostersTable.id, d.id));
    }
  } catch (err) {
    logger.error({ err, ownerUserId }, "consumeBoosterOverflow failed");
  }
}

// Daily sweep: flip boosters past their expiry to "expired" so they stop
// counting toward the plafon. Idempotent (only touches still-active rows).
export async function expireBoosters(now: Date = new Date()): Promise<number> {
  const res = await db
    .update(tokenBoostersTable)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(tokenBoostersTable.status, "active"),
        lt(tokenBoostersTable.expiresAt, now)
      )
    );
  return res.rowCount ?? 0;
}

let boosterExpiryTimer: NodeJS.Timeout | null = null;

export function startBoosterExpiryScheduler(): void {
  if (boosterExpiryTimer) return;
  const DAY = 24 * 60 * 60 * 1000;
  const run = () => {
    expireBoosters()
      .then((n) => {
        if (n > 0) logger.info({ expired: n }, "token boosters expired");
      })
      .catch((err) => logger.error({ err }, "booster expiry sweep failed"));
  };
  // First run a few minutes after boot to avoid colliding with startup work.
  setTimeout(run, 6 * 60 * 1000);
  boosterExpiryTimer = setInterval(run, DAY);
}
