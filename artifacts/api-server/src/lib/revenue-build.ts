// Pure, db-free revenue-aggregation helpers (Billing v2 — FASE H). Kept free of
// any @workspace/db runtime import so they stay unit-testable under the
// node:test runner (the db package connects eagerly on import). Revenue / MRR /
// ARPU now read from the immutable `invoices` instead of the metered usage
// snapshots, so financials are snapshot-correct (a later catalog price change
// never rewrites history).

// One daily point in the revenue trend. The metered per-category breakdown
// (db/user/channel/ai) no longer applies to the invoice-sourced trend — those
// fields are kept at 0 for contract stability (the chart only renders
// totalCharge), and the legacy metered breakdown still flows through
// computeOwnerTrend, which is unchanged.
export interface RevenueTrendPoint {
  date: string; // YYYY-MM-DD
  totalCharge: number;
  dbCharge: number;
  userCharge: number;
  channelCharge: number;
}

// Minimal projection of an invoice row the aggregators need.
export interface RevenueInvoiceInput {
  userId: number;
  source: string; // "payment" | "monthly_close"
  totalIdr: number;
  issuedAt: Date;
}

function dateKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// MRR = the sum, over the given (effective-active) owners, of each owner's
// LATEST `monthly_close` invoice total. monthly_close invoices are the recurring
// obligation (one per owner per billing period), so the newest one per owner is
// that owner's current recurring revenue. One-off `payment` invoices are NOT
// recurring and are excluded. Owners without a monthly_close invoice yet
// contribute 0 (no recurring charge recorded).
export function mrrFromInvoices(
  invoices: RevenueInvoiceInput[],
  activeOwnerIds: Iterable<number>
): number {
  const active = new Set<number>(activeOwnerIds);
  const latestPerOwner = new Map<number, { at: number; totalIdr: number }>();
  for (const inv of invoices) {
    if (inv.source !== "monthly_close") continue;
    if (!active.has(inv.userId)) continue;
    const at = inv.issuedAt.getTime();
    const cur = latestPerOwner.get(inv.userId);
    if (!cur || at > cur.at) {
      latestPerOwner.set(inv.userId, { at, totalIdr: inv.totalIdr });
    }
  }
  let mrr = 0;
  for (const { totalIdr } of latestPerOwner.values()) mrr += totalIdr;
  return mrr;
}

// Daily invoiced revenue across all tenant owners: sum of every invoice total
// (both `payment` one-offs and `monthly_close` recurring) grouped by the UTC day
// it was issued, on/after `sinceDate` (YYYY-MM-DD, inclusive), oldest-first.
// Days with no invoices are omitted (the chart tolerates sparse points). The
// per-category breakdown is 0 — invoices don't carry the metered categories.
export function dailyRevenueTrendFromInvoices(
  invoices: { issuedAt: Date; totalIdr: number }[],
  sinceDate: string
): RevenueTrendPoint[] {
  const byDate = new Map<string, number>();
  for (const inv of invoices) {
    const date = dateKeyUtc(inv.issuedAt);
    if (date < sinceDate) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + inv.totalIdr);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, totalCharge]) => ({
      date,
      totalCharge,
      dbCharge: 0,
      userCharge: 0,
      channelCharge: 0,
    }));
}
