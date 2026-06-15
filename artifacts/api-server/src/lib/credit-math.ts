// Pure (db-free) arithmetic for the prepaid AI-credit wallet ("Dompet Kredit
// Prabayar"). No DB, no I/O — unit-testable in isolation, so the money math is
// covered without touching Postgres (see CLAUDE.md "Unit tests").
//
// Credits are an abstraction over tokens: every AI completion converts its
// token usage into whole-integer credits via the platform owner's configured
// per-1k rate and markup. Spend always drains the `grant` bucket (plan
// allowance, expires) before the `paid` bucket (purchased top-ups, rollover).

/** Clamp to a non-negative finite integer; anything else → 0. */
function nonNegInt(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Convert token usage into whole credits, applying the engine's per-1k rate and
 * the platform markup. Credits are billed up (ceil) so a sub-1k call is never
 * free. Returns 0 for zero/invalid token counts.
 *
 *   credits = ceil( (totalTokens / 1000) * creditPer1kToken * (1 + markupBps/10000) )
 *
 * Example: 1000 tokens @ rate 1000, markup 5000bps (+50%) → ceil(1500) = 1500.
 */
export function tokensToCredits(
  totalTokens: number | null | undefined,
  creditPer1kToken: number | null | undefined,
  markupBps: number | null | undefined,
): number {
  const tokens = nonNegInt(totalTokens);
  const rate = nonNegInt(creditPer1kToken);
  if (tokens === 0 || rate === 0) return 0;
  const bps = typeof markupBps === "number" && Number.isFinite(markupBps) && markupBps > 0 ? markupBps : 0;
  const base = (tokens / 1000) * rate;
  const withMarkup = base * (1 + bps / 10_000);
  return Math.ceil(withMarkup);
}

/** A grant whose expiry has passed contributes nothing to a balance. */
export function isGrantExpired(
  grantExpiresAt: Date | null | undefined,
  now: Date,
): boolean {
  return grantExpiresAt != null && grantExpiresAt.getTime() <= now.getTime();
}

/** Grant credits that still count, given expiry. Expired grant → 0. */
export function effectiveGrant(
  grantBalance: number,
  grantExpiresAt: Date | null | undefined,
  now: Date,
): number {
  return isGrantExpired(grantExpiresAt, now) ? 0 : nonNegInt(grantBalance);
}

/**
 * Spendable balance after subtracting active reservations. Grant is counted
 * only if unexpired. Never negative.
 */
export function availableBalance(input: {
  grantBalance: number;
  grantExpiresAt: Date | null | undefined;
  paidBalance: number;
  reserved: number;
  now: Date;
}): number {
  const grant = effectiveGrant(input.grantBalance, input.grantExpiresAt, input.now);
  const paid = nonNegInt(input.paidBalance);
  const reserved = nonNegInt(input.reserved);
  return Math.max(0, grant + paid - reserved);
}

export interface SpendPlan {
  /** Credits drawn from the grant bucket (spent first). */
  fromGrant: number;
  /** Credits drawn from the paid bucket (after grant is exhausted). */
  fromPaid: number;
  /** Grant balance after the spend. */
  grantAfter: number;
  /** Paid balance after the spend. */
  paidAfter: number;
  /**
   * Credits that could NOT be covered by either bucket (wallet went to zero).
   * The caller still records the full charge as ledger usage; shortfall just
   * means the tenant briefly outran their balance (e.g. concurrent calls).
   */
  shortfall: number;
}

/**
 * Plan how to draw `amount` credits, grant-first then paid. Expired grant is
 * treated as empty. The buckets never go negative; any uncovered remainder is
 * reported as `shortfall` (the pre-call guard normally prevents this, but
 * concurrent settlements can still race the balance to zero).
 */
export function planSpend(
  amount: number,
  input: {
    grantBalance: number;
    grantExpiresAt: Date | null | undefined;
    paidBalance: number;
    now: Date;
  },
): SpendPlan {
  const want = nonNegInt(amount);
  const grant = effectiveGrant(input.grantBalance, input.grantExpiresAt, input.now);
  const paid = nonNegInt(input.paidBalance);

  const fromGrant = Math.min(want, grant);
  const remainder = want - fromGrant;
  const fromPaid = Math.min(remainder, paid);
  const shortfall = remainder - fromPaid;

  return {
    fromGrant,
    fromPaid,
    grantAfter: grant - fromGrant,
    paidAfter: paid - fromPaid,
    shortfall,
  };
}

/** Assumed completion size when reserving before the real usage is known. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Estimate the total tokens a call will consume (input + an assumed worst-case
 * output) so the reservation over-, not under-, shoots.
 */
export function estimateTotalTokens(
  inputTokens: number | null | undefined,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  return nonNegInt(inputTokens) + Math.max(0, Math.floor(maxOutputTokens));
}

/**
 * Worst-case credit reservation for a call that may fail over across engines:
 * price the estimated tokens at the MOST EXPENSIVE enabled engine's rate
 * (SPEC BAGIAN 7), so a failover to a pricier engine can never overspend the
 * hold. Returns 0 when no engines are enabled.
 */
export function worstCaseEstimate(
  inputTokens: number,
  enabledEngines: ReadonlyArray<{ creditPer1kToken: number }>,
  markupBps: number,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  if (enabledEngines.length === 0) return 0;
  const maxPer1k = Math.max(...enabledEngines.map((e) => nonNegInt(e.creditPer1kToken)));
  return tokensToCredits(estimateTotalTokens(inputTokens, maxOutputTokens), maxPer1k, markupBps);
}

/**
 * Project how many days of runway remain given recent burn. `windowDays` is the
 * period the spend was measured over. Returns null (unknown / effectively
 * infinite) when there is no measured spend.
 */
export function estDaysLeft(
  totalCredits: number,
  creditsSpentInWindow: number,
  windowDays: number,
): number | null {
  const total = nonNegInt(totalCredits);
  const spent = nonNegInt(creditsSpentInWindow);
  const days = Math.max(1, Math.floor(windowDays));
  if (spent === 0) return null;
  const perDay = spent / days;
  return Math.floor(total / perDay);
}

/**
 * Low-balance notification thresholds (percent of the period's starting
 * balance). We notify once per downward crossing — see credit_notify_state.
 */
export const NOTIFY_THRESHOLDS = [20, 5, 0] as const;

/**
 * Given the previously-notified threshold and the current remaining percent,
 * return the lowest threshold newly crossed downward (or null if none). Lets
 * the notifier fire exactly once per crossing instead of on every low balance.
 */
export function crossedThreshold(
  lastThreshold: number,
  remainingPercent: number,
): number | null {
  let crossed: number | null = null;
  for (const t of NOTIFY_THRESHOLDS) {
    if (remainingPercent <= t && t < lastThreshold) {
      crossed = t; // thresholds descend, so the last match is the lowest crossed
    }
  }
  return crossed;
}

export type CreditNotice = "ok" | "low" | "critical" | "empty";

/**
 * Map a wallet's remaining percent + spendable balance to the banner level the
 * tenant UI renders (SPEC BAGIAN 11.1 / 13.2): empty when spend is gated (≤
 * min-stop), then critical ≤5%, low ≤20%, else ok.
 */
export function creditNoticeLevel(
  remainingPercent: number,
  available: number,
  minStopCredits: number,
): CreditNotice {
  if (nonNegInt(available) <= Math.max(0, Math.floor(minStopCredits))) return "empty";
  if (remainingPercent <= 5) return "critical";
  if (remainingPercent <= 20) return "low";
  return "ok";
}

/**
 * Reconstruct the period's remaining percent from the live balance and the
 * credits already spent this period: baseline = available + spentThisPeriod, so
 * the figure is stable as spend accrues and only rises on a top-up/grant. 100%
 * when there is no measurable baseline (fresh / unfunded period).
 */
export function remainingPercent(available: number, spentThisPeriod: number): number {
  const avail = nonNegInt(available);
  const baseline = avail + nonNegInt(spentThisPeriod);
  if (baseline <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((avail / baseline) * 100)));
}
