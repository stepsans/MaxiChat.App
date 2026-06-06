// Pure, db-free billing math for the usage-based pricing model. Kept free of
// any @workspace/db import so it can be unit-tested directly (the db package
// connects eagerly). All money is whole Indonesian Rupiah.
//
// Pricing model (each component billed in buckets, rounded UP):
//   db      = ceil(storageMb / 500)  * dbPricePer500Mb
//   user    = childUserCount         * userPricePerUser
//   channel = ceil(channelCount / 2) * channelPricePer2
//   ai      = ceil(tokenUsage / 100) * aiPricePer100Tokens
//   total   = sum of the four

export interface BillingPricing {
  dbPricePer500Mb: number;
  userPricePerUser: number;
  channelPricePer2: number;
  aiPricePer100Tokens: number;
}

export interface BillingUsage {
  storageBytes: number;
  childUserCount: number;
  channelCount: number;
  tokenUsage: number;
}

export interface BillBreakdown {
  dbCharge: number;
  userCharge: number;
  channelCharge: number;
  aiCharge: number;
  total: number;
}

const BYTES_PER_MB = 1024 * 1024;

// Whole buckets needed to cover `amount` at `per` units per bucket. Returns 0
// for non-positive usage; never negative. A non-positive bucket size disables
// that component (returns 0) so a misconfigured price can't divide-by-zero.
function buckets(amount: number, per: number): number {
  if (amount <= 0 || per <= 0) return 0;
  return Math.ceil(amount / per);
}

export function computeMonthlyBill(
  usage: BillingUsage,
  pricing: BillingPricing
): BillBreakdown {
  const storageMb = Math.max(0, usage.storageBytes) / BYTES_PER_MB;

  const dbCharge = buckets(storageMb, 500) * Math.max(0, pricing.dbPricePer500Mb);
  const userCharge =
    Math.max(0, Math.floor(usage.childUserCount)) *
    Math.max(0, pricing.userPricePerUser);
  const channelCharge =
    buckets(usage.channelCount, 2) * Math.max(0, pricing.channelPricePer2);
  const aiCharge =
    buckets(usage.tokenUsage, 100) * Math.max(0, pricing.aiPricePer100Tokens);

  const total = dbCharge + userCharge + channelCharge + aiCharge;

  return { dbCharge, userCharge, channelCharge, aiCharge, total };
}

// ----- Subscription status (db-free, so it's unit-testable) -----

// The four stored statuses. "effective" status additionally collapses an
// overdue trial/active into "expired" based on the wall clock — the stored
// row may lag (the scheduler flips it once a day) but enforcement must react
// the instant the period boundary passes.
export type StoredSubscriptionStatus =
  | "trial"
  | "active"
  | "expired"
  | "suspended";

// Given the STORED status + period end, return the EFFECTIVE status right now.
// - suspended/expired stay as-is (a manual suspend wins regardless of date).
// - trial/active become "expired" once `now` is past `periodEnd`.
// - a null periodEnd means "no expiry set" → keep trial/active as-is.
export function computeEffectiveStatus(
  status: string,
  periodEnd: string | Date | null,
  now: Date
): StoredSubscriptionStatus {
  if (status === "suspended") return "suspended";
  if (status === "expired") return "expired";
  const active = status === "trial" || status === "active";
  if (!active) return "expired"; // unknown status → treat as not-paying
  if (periodEnd == null) return status as StoredSubscriptionStatus;
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return status as StoredSubscriptionStatus;
  return now.getTime() > end.getTime()
    ? "expired"
    : (status as StoredSubscriptionStatus);
}

// A read-only tenant can still log in and view everything, but every write
// (send message, edit settings, add channel/user, run AI) is blocked.
export function isReadOnlySubscription(effectiveStatus: string): boolean {
  return effectiveStatus === "expired" || effectiveStatus === "suspended";
}

// Add `n` whole months to `date` in UTC, clamping the day to the last day of
// the target month (e.g. Jan 31 + 1 = Feb 28/29). Used to extend a paid
// period. `n` may be fractional? No — callers pass whole months.
export function addMonths(date: Date, n: number): Date {
  const months = Math.trunc(n);
  const year = date.getUTCFullYear();
  const month0 = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonthIndex = month0 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth0 = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth0 + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth0,
      clampedDay,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}
