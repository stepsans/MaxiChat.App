import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  creditWalletTable,
  creditLedgerTable,
  creditHoldTable,
  creditNotifyStateTable,
  aiUsageEventsTable,
  type CreditWalletRow,
  type CreditLedgerRow,
} from "@workspace/db";
import {
  availableBalance,
  effectiveGrant,
  planSpend,
  estDaysLeft,
  remainingPercent,
  creditNoticeLevel,
  type CreditNotice,
} from "./credit-math";
import { logger } from "./logger";

// A db handle or an open transaction — lets grant/top-up compose inside the
// settlement transaction (settlePaymentPaid) so a credit grant and the paid-flip
// are all-or-nothing.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ===========================================================================
// Prepaid AI-credit wallet — the DB layer behind the "gerbang prabayar"
// (prepaid gate) on every centralized-engine AI call. All money math lives in
// the db-free credit-math.ts; this module is the persistence + concurrency
// boundary.
//
// Per-call lifecycle:
//   1) reserveForCall  — hold an estimate, fail fast if the wallet can't cover it
//   2) ...AI call runs...
//   3) settleCall      — debit the ACTUAL credits (grant-first), release the hold
//
// Both reserve and settle are idempotent on callId: a hold's PK is the callId,
// and the ledger's partial unique index guarantees one `usage` row per callId.
// A reservation whose call dies before settling is reclaimed by the expiry
// sweep (startCreditHoldSweeper), so a crash never leaks `reserved` forever.
//
// NOTE: credits ≠ Rupiah. This wallet is entirely separate from the billing-v2
// `wallet` (balanceIdr) — never conflate the two.
// ===========================================================================

/** Default reservation per call (in tokens) before the real usage is known. */
const RESERVE_ESTIMATE_TOKENS = 4000;
/** A reservation is reclaimed by the sweep after this long if never settled. */
const HOLD_TTL_MS = 5 * 60_000;

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly available: number,
    public readonly required: number,
  ) {
    super("Saldo kredit AI tidak mencukupi.");
    this.name = "InsufficientCreditsError";
  }
}

/** Read the owner's wallet, creating an empty one on first touch. */
export async function getOrCreateWallet(ownerUserId: number): Promise<CreditWalletRow> {
  const [existing] = await db
    .select()
    .from(creditWalletTable)
    .where(eq(creditWalletTable.ownerUserId, ownerUserId))
    .limit(1);
  if (existing) return existing;
  await db
    .insert(creditWalletTable)
    .values({ ownerUserId })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(creditWalletTable)
    .where(eq(creditWalletTable.ownerUserId, ownerUserId))
    .limit(1);
  return row;
}

export interface WalletBalance {
  grantBalance: number;
  grantExpiresAt: Date | null;
  paidBalance: number;
  paidExpiresAt: Date | null;
  reserved: number;
  /** grant (if unexpired) + paid − reserved, never negative. */
  available: number;
}

/** Owner-facing balance snapshot, with expired grant already zeroed out. */
export async function getWalletBalance(
  ownerUserId: number,
  now: Date = new Date(),
): Promise<WalletBalance> {
  const w = await getOrCreateWallet(ownerUserId);
  return {
    grantBalance: w.grantBalance,
    grantExpiresAt: w.grantExpiresAt,
    paidBalance: w.paidBalance,
    paidExpiresAt: w.paidExpiresAt,
    reserved: w.reserved,
    available: availableBalance({
      grantBalance: w.grantBalance,
      grantExpiresAt: w.grantExpiresAt,
      paidBalance: w.paidBalance,
      reserved: w.reserved,
      now,
    }),
  };
}

// --- notify-state period tracking ------------------------------------------

/** Sum of credits spent (reason='usage') for an owner since `since`. */
async function sumUsageSince(ownerUserId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(-sum(${creditLedgerTable.delta}), 0)::int` })
    .from(creditLedgerTable)
    .where(
      and(
        eq(creditLedgerTable.ownerUserId, ownerUserId),
        eq(creditLedgerTable.reason, "usage"),
        gte(creditLedgerTable.createdAt, since),
      ),
    );
  return row?.spent ?? 0;
}

/** Read the notify-state row (period anchor + last threshold), creating it on
 * first touch with the current time as the period start. */
export async function getNotifyState(
  ownerUserId: number,
  now: Date = new Date(),
): Promise<{ lastThreshold: number; periodStart: Date }> {
  const [existing] = await db
    .select()
    .from(creditNotifyStateTable)
    .where(eq(creditNotifyStateTable.ownerUserId, ownerUserId))
    .limit(1);
  if (existing) {
    return { lastThreshold: existing.lastThreshold, periodStart: existing.periodStart ?? now };
  }
  await db
    .insert(creditNotifyStateTable)
    .values({ ownerUserId, lastThreshold: 100, periodStart: now })
    .onConflictDoNothing();
  return { lastThreshold: 100, periodStart: now };
}

/** Persist the last-notified threshold (anti-spam: notify once per crossing). */
export async function setNotifyThreshold(
  ownerUserId: number,
  threshold: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(creditNotifyStateTable)
    .values({ ownerUserId, lastThreshold: threshold, periodStart: now })
    .onConflictDoUpdate({
      target: creditNotifyStateTable.ownerUserId,
      set: { lastThreshold: threshold, updatedAt: now },
    });
}

export interface CreditWalletSummary {
  grantBalance: number;
  grantExpiresAt: Date | null;
  paidBalance: number;
  paidExpiresAt: Date | null;
  reserved: number;
  /** effective grant (0 if expired) + paid. */
  total: number;
  /** total − reserved, never negative — what's actually spendable. */
  available: number;
  spentLast30d: number;
  /** Projected days of runway from the 30-day burn (null = unknown). */
  estDaysLeft: number | null;
  /** 0..100, reconstructed from this period's spend. */
  percentRemaining: number;
  notice: CreditNotice;
}

/**
 * Owner-facing wallet summary for the tenant billing page (SPEC BAGIAN 13.2):
 * two-bucket balances, runway, and the banner level. `minStopCredits` is the
 * platform's hard-stop floor (passed in to avoid coupling this DB module to the
 * platform-AI config and risking an import cycle).
 */
export async function getCreditWalletSummary(
  ownerUserId: number,
  minStopCredits = 0,
  now: Date = new Date(),
): Promise<CreditWalletSummary> {
  const w = await getOrCreateWallet(ownerUserId);
  const grantEff = effectiveGrant(w.grantBalance, w.grantExpiresAt, now);
  const total = grantEff + w.paidBalance;
  const available = Math.max(0, total - w.reserved);

  const { periodStart } = await getNotifyState(ownerUserId, now);
  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [spentLast30d, spentThisPeriod] = await Promise.all([
    sumUsageSince(ownerUserId, since30),
    sumUsageSince(ownerUserId, periodStart),
  ]);

  const pct = remainingPercent(available, spentThisPeriod);
  return {
    grantBalance: grantEff,
    grantExpiresAt: w.grantExpiresAt,
    paidBalance: w.paidBalance,
    paidExpiresAt: w.paidExpiresAt,
    reserved: w.reserved,
    total,
    available,
    spentLast30d,
    estDaysLeft: estDaysLeft(total, spentLast30d, 30),
    percentRemaining: pct,
    notice: creditNoticeLevel(pct, available, minStopCredits),
  };
}

export interface CreditUsageRow {
  createdAt: Date;
  channelId: number | null;
  engine: string | null;
  model: string;
  totalTokens: number;
  creditsCharged: number;
}

/** Recent AI usage attributed to the owner, newest-first (SPEC BAGIAN 10.3). */
export async function listCreditUsage(
  ownerUserId: number,
  days = 30,
  limit = 100,
  now: Date = new Date(),
): Promise<CreditUsageRow[]> {
  const since = new Date(now.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  return db
    .select({
      createdAt: aiUsageEventsTable.createdAt,
      channelId: aiUsageEventsTable.channelId,
      engine: aiUsageEventsTable.engine,
      model: aiUsageEventsTable.model,
      totalTokens: aiUsageEventsTable.totalTokens,
      creditsCharged: aiUsageEventsTable.creditsCharged,
    })
    .from(aiUsageEventsTable)
    .where(and(eq(aiUsageEventsTable.userId, ownerUserId), gte(aiUsageEventsTable.createdAt, since)))
    .orderBy(desc(aiUsageEventsTable.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
}

/** Recent credit-ledger entries (top-ups, usage, grants, expiries), newest-first. */
export async function listCreditLedger(
  ownerUserId: number,
  limit = 100,
): Promise<CreditLedgerRow[]> {
  return db
    .select()
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.ownerUserId, ownerUserId))
    .orderBy(desc(creditLedgerTable.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
}

/**
 * Read-only gate check: throws InsufficientCreditsError when the spendable
 * balance is at or below the platform's hard-stop floor. Used as a cheap
 * pre-flight before reserving.
 */
export async function guardCredits(
  ownerUserId: number,
  minStopCredits: number,
  now: Date = new Date(),
): Promise<number> {
  const { available } = await getWalletBalance(ownerUserId, now);
  if (available <= Math.max(0, minStopCredits)) {
    throw new InsufficientCreditsError(available, minStopCredits + 1);
  }
  return available;
}

/**
 * Reserve an estimated charge for an in-flight call. Locks the wallet row so
 * concurrent calls serialise on `reserved` and can't collectively overspend.
 * Idempotent: a second reserve with the same callId is a no-op.
 *
 * Throws InsufficientCreditsError when the post-reserve available balance would
 * fall to or below `minStopCredits`.
 */
export async function reserveForCall(opts: {
  ownerUserId: number;
  callId: string;
  estimatedCredits: number;
  minStopCredits: number;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const estimate = Math.max(0, Math.floor(opts.estimatedCredits));
  await db.transaction(async (tx) => {
    const [w] = await tx
      .select()
      .from(creditWalletTable)
      .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId))
      .for("update")
      .limit(1);
    if (!w) {
      // No wallet row yet → no credits → reject (the gate is only consulted for
      // active platform tenants, who are expected to have a funded wallet).
      throw new InsufficientCreditsError(0, estimate);
    }

    // Idempotency: if a hold already exists for this callId, don't double-count.
    const [held] = await tx
      .select({ amount: creditHoldTable.amount })
      .from(creditHoldTable)
      .where(eq(creditHoldTable.callId, opts.callId))
      .limit(1);
    if (held) return;

    const available = availableBalance({
      grantBalance: w.grantBalance,
      grantExpiresAt: w.grantExpiresAt,
      paidBalance: w.paidBalance,
      reserved: w.reserved,
      now,
    });
    if (available - estimate <= Math.max(0, opts.minStopCredits)) {
      throw new InsufficientCreditsError(available, estimate);
    }

    await tx.insert(creditHoldTable).values({
      callId: opts.callId,
      ownerUserId: opts.ownerUserId,
      amount: estimate,
      expiresAt: new Date(now.getTime() + HOLD_TTL_MS),
    });
    await tx
      .update(creditWalletTable)
      .set({ reserved: w.reserved + estimate, updatedAt: now })
      .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId));
  });
}

/** Convenience: reserve using the default token estimate + the engine rate. */
export function estimateReserveCredits(creditPer1kToken: number, markupBps: number): number {
  // Mirror credit-math.tokensToCredits for a typical call so the reserve is in
  // the right ballpark; the real charge is reconciled at settle.
  const base = (RESERVE_ESTIMATE_TOKENS / 1000) * Math.max(0, creditPer1kToken);
  return Math.ceil(base * (1 + Math.max(0, markupBps) / 10_000));
}

export interface SettleResult {
  charged: number;
  fromGrant: number;
  fromPaid: number;
  shortfall: number;
  alreadySettled: boolean;
}

/**
 * Debit the actual credits for a completed call (grant-first), release the
 * call's reservation, and append the audit ledger row. Idempotent on callId:
 * the ledger's partial unique index (`reason='usage'`) makes a re-settle a
 * no-op that returns the original charge.
 */
export async function settleCall(opts: {
  ownerUserId: number;
  callId: string;
  actualCredits: number;
  now?: Date;
}): Promise<SettleResult> {
  const now = opts.now ?? new Date();
  const amount = Math.max(0, Math.floor(opts.actualCredits));

  return db.transaction(async (tx) => {
    // Idempotency: a prior `usage` ledger row for this callId means it already
    // settled. Return the original charge without touching the wallet again.
    const [prior] = await tx
      .select({ delta: creditLedgerTable.delta })
      .from(creditLedgerTable)
      .where(and(eq(creditLedgerTable.callId, opts.callId), eq(creditLedgerTable.reason, "usage")))
      .limit(1);
    if (prior) {
      return { charged: -prior.delta, fromGrant: 0, fromPaid: 0, shortfall: 0, alreadySettled: true };
    }

    const [w] = await tx
      .select()
      .from(creditWalletTable)
      .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId))
      .for("update")
      .limit(1);

    // Release this call's hold (whichever of settle/sweep deletes it owns the
    // reserved decrement, so the counter is touched exactly once).
    const released = await tx
      .delete(creditHoldTable)
      .where(eq(creditHoldTable.callId, opts.callId))
      .returning({ amount: creditHoldTable.amount });
    const heldAmount = released[0]?.amount ?? 0;

    if (!w) {
      // No wallet (shouldn't happen on the gated path) — record the charge as
      // pure shortfall so usage is still auditable.
      return { charged: 0, fromGrant: 0, fromPaid: 0, shortfall: amount, alreadySettled: false };
    }

    const plan = planSpend(amount, {
      grantBalance: w.grantBalance,
      grantExpiresAt: w.grantExpiresAt,
      paidBalance: w.paidBalance,
      now,
    });

    const newReserved = Math.max(0, w.reserved - heldAmount);
    await tx
      .update(creditWalletTable)
      .set({
        grantBalance: plan.grantAfter,
        paidBalance: plan.paidAfter,
        reserved: newReserved,
        updatedAt: now,
      })
      .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId));

    const charged = plan.fromGrant + plan.fromPaid;
    if (charged > 0) {
      // One usage row per call (the partial unique index enforces it). bucket
      // records where the spend primarily landed; the split is reflected in the
      // wallet balances.
      await tx.insert(creditLedgerTable).values({
        ownerUserId: opts.ownerUserId,
        delta: -charged,
        bucket: plan.fromPaid > 0 ? "paid" : "grant",
        reason: "usage",
        callId: opts.callId,
        balanceAfter: plan.grantAfter + plan.paidAfter,
      });
    }

    return {
      charged,
      fromGrant: plan.fromGrant,
      fromPaid: plan.fromPaid,
      shortfall: plan.shortfall,
      alreadySettled: false,
    };
  });
}

/** Release a reservation without charging (call failed before producing usage). */
export async function releaseHold(callId: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const released = await tx
      .delete(creditHoldTable)
      .where(eq(creditHoldTable.callId, callId))
      .returning({ ownerUserId: creditHoldTable.ownerUserId, amount: creditHoldTable.amount });
    const hold = released[0];
    if (!hold) return;
    await tx
      .update(creditWalletTable)
      .set({ reserved: sql`greatest(0, ${creditWalletTable.reserved} - ${hold.amount})`, updatedAt: now })
      .where(eq(creditWalletTable.ownerUserId, hold.ownerUserId));
  });
}

/** Select-or-insert the wallet row on a given executor (tx-safe). */
async function ensureWalletRow(ownerUserId: number, exec: DbExecutor): Promise<CreditWalletRow> {
  const [existing] = await exec
    .select()
    .from(creditWalletTable)
    .where(eq(creditWalletTable.ownerUserId, ownerUserId))
    .limit(1);
  if (existing) return existing;
  await exec.insert(creditWalletTable).values({ ownerUserId }).onConflictDoNothing();
  const [row] = await exec
    .select()
    .from(creditWalletTable)
    .where(eq(creditWalletTable.ownerUserId, ownerUserId))
    .limit(1);
  return row;
}

/**
 * Grant plan-allowance (Ember A) credits, RESETTING the bucket and its expiry
 * (SPEC BAGIAN 9 — perpanjangan set ulang; sisa lama hangus). Any leftover from
 * the prior period is recorded as an `expire` ledger row for audit, then the new
 * allowance replaces it. Runs on the caller's executor so it can join the
 * settlement transaction.
 */
export async function grantCredits(
  opts: {
    ownerUserId: number;
    amount: number;
    expiresAt: Date | null;
    now?: Date;
  },
  exec: DbExecutor = db,
): Promise<void> {
  const now = opts.now ?? new Date();
  const amount = Math.max(0, Math.floor(opts.amount));
  const w = await ensureWalletRow(opts.ownerUserId, exec);

  // Expire the old grant remnant first (audit), so the ledger reflects the reset.
  if (w.grantBalance > 0) {
    await exec.insert(creditLedgerTable).values({
      ownerUserId: opts.ownerUserId,
      delta: -w.grantBalance,
      bucket: "grant",
      reason: "expire",
      balanceAfter: w.paidBalance, // grant bucket now 0
    });
  }

  await exec
    .update(creditWalletTable)
    .set({ grantBalance: amount, grantExpiresAt: opts.expiresAt, updatedAt: now })
    .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId));
  await exec.insert(creditLedgerTable).values({
    ownerUserId: opts.ownerUserId,
    delta: amount,
    bucket: "grant",
    reason: "grant",
    balanceAfter: amount + w.paidBalance,
  });

  // A renewal starts a fresh notification period: re-anchor period_start and
  // re-arm the threshold so a future dip notifies again (SPEC BAGIAN 11.1).
  await exec
    .insert(creditNotifyStateTable)
    .values({ ownerUserId: opts.ownerUserId, lastThreshold: 100, periodStart: now })
    .onConflictDoUpdate({
      target: creditNotifyStateTable.ownerUserId,
      set: { lastThreshold: 100, periodStart: now, updatedAt: now },
    });
}

/**
 * Add purchased (Ember B) credits on top of the existing balance (rollover,
 * never reset). Runs on the caller's executor so a top-up joins the
 * settlePaymentPaid transaction.
 */
export async function addPaidCredits(
  opts: {
    ownerUserId: number;
    amount: number;
    reason?: string;
    now?: Date;
  },
  exec: DbExecutor = db,
): Promise<void> {
  const now = opts.now ?? new Date();
  const amount = Math.max(0, Math.floor(opts.amount));
  if (amount === 0) return;
  const w = await ensureWalletRow(opts.ownerUserId, exec);
  const newPaid = w.paidBalance + amount;
  await exec
    .update(creditWalletTable)
    .set({ paidBalance: newPaid, updatedAt: now })
    .where(eq(creditWalletTable.ownerUserId, opts.ownerUserId));
  await exec.insert(creditLedgerTable).values({
    ownerUserId: opts.ownerUserId,
    delta: amount,
    bucket: "paid",
    reason: opts.reason ?? "topup",
    balanceAfter: newPaid + w.grantBalance,
  });

  // A top-up restores the balance → re-arm the low-balance notifier so the next
  // dip re-notifies (keep the period anchor; baseline grows with the top-up).
  await exec
    .insert(creditNotifyStateTable)
    .values({ ownerUserId: opts.ownerUserId, lastThreshold: 100, periodStart: now })
    .onConflictDoUpdate({
      target: creditNotifyStateTable.ownerUserId,
      set: { lastThreshold: 100, updatedAt: now },
    });
}

/**
 * Reclaim reservations whose calls never settled (crash / dropped path).
 * Claims each expired hold atomically via DELETE…RETURNING so settle and the
 * sweep never decrement the same hold twice.
 */
export async function sweepExpiredHolds(now: Date = new Date()): Promise<number> {
  const expired = await db
    .delete(creditHoldTable)
    .where(lte(creditHoldTable.expiresAt, now))
    .returning({ ownerUserId: creditHoldTable.ownerUserId, amount: creditHoldTable.amount });
  if (expired.length === 0) return 0;

  const byOwner = new Map<number, number>();
  for (const h of expired) {
    byOwner.set(h.ownerUserId, (byOwner.get(h.ownerUserId) ?? 0) + h.amount);
  }
  for (const [ownerUserId, amount] of byOwner) {
    await db
      .update(creditWalletTable)
      .set({ reserved: sql`greatest(0, ${creditWalletTable.reserved} - ${amount})`, updatedAt: now })
      .where(eq(creditWalletTable.ownerUserId, ownerUserId));
  }
  return expired.length;
}

/**
 * Zero out grants whose expiry has passed (SPEC BAGIAN 9 — grant hangus akhir
 * periode), recording an `expire` ledger row per wallet. Reads already treat an
 * expired grant as 0 (effectiveGrant); this keeps the stored balance + ledger
 * truthful between renewals. Idempotent: only touches rows still holding an
 * expired grant.
 */
export async function sweepExpiredGrants(now: Date = new Date()): Promise<number> {
  const expired = await db
    .select({ ownerUserId: creditWalletTable.ownerUserId, grantBalance: creditWalletTable.grantBalance, paidBalance: creditWalletTable.paidBalance })
    .from(creditWalletTable)
    .where(and(lte(creditWalletTable.grantExpiresAt, now), sql`${creditWalletTable.grantBalance} > 0`));
  if (expired.length === 0) return 0;

  for (const w of expired) {
    await db.transaction(async (tx) => {
      // Re-check under lock so a concurrent renewal/spend doesn't double-expire.
      const [cur] = await tx
        .select()
        .from(creditWalletTable)
        .where(eq(creditWalletTable.ownerUserId, w.ownerUserId))
        .for("update")
        .limit(1);
      if (!cur || cur.grantBalance <= 0 || !cur.grantExpiresAt || cur.grantExpiresAt.getTime() > now.getTime()) {
        return;
      }
      await tx
        .update(creditWalletTable)
        .set({ grantBalance: 0, updatedAt: now })
        .where(eq(creditWalletTable.ownerUserId, w.ownerUserId));
      await tx.insert(creditLedgerTable).values({
        ownerUserId: w.ownerUserId,
        delta: -cur.grantBalance,
        bucket: "grant",
        reason: "expire",
        balanceAfter: cur.paidBalance,
      });
    });
  }
  return expired.length;
}

let sweeperStarted = false;

/**
 * Start the credit sweepers (mirrors the other in-process pollers): reclaim
 * expired holds every minute, and expire stale grants.
 */
export function startCreditHoldSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const tick = async () => {
    try {
      const n = await sweepExpiredHolds();
      if (n > 0) logger.info({ reclaimed: n }, "credit hold sweep reclaimed expired reservations");
    } catch (err) {
      logger.error({ err }, "credit hold sweep failed");
    }
    try {
      const g = await sweepExpiredGrants();
      if (g > 0) logger.info({ expired: g }, "credit grant sweep zeroed expired grants");
    } catch (err) {
      logger.error({ err }, "credit grant sweep failed");
    }
  };
  setInterval(() => void tick(), 60_000);
  logger.info("credit sweepers started");
}
