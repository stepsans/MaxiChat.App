import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  aiUsageEventsTable,
  platformAiEngineTable,
  creditLedgerTable,
  paymentsTable,
  addonsTable,
} from "@workspace/db";
import { logger } from "./logger";

// ===========================================================================
// Platform owner margin & reconciliation (SPEC BAGIAN 14). Revenue vs COGS,
// split per engine. The exact provider Rupiah COGS lives in each provider's
// own console (DeepSeek/Google/OpenAI/Anthropic invoices) and is reconciled
// manually against the per-engine token totals reported here; what we CAN
// compute exactly is:
//   - revenueCredits  = credits charged to tenants (with markup) per engine
//   - costCredits      = the un-marked-up base credits (provider-cost proxy)
//   - marginCredits    = revenueCredits − costCredits (the markup margin)
//   - revenueIdr       = actual paid top-ups in Rupiah (Σ token-addon payments)
// plus a ledger reconciliation block (usage vs top-up vs grant credits).
// ===========================================================================

export interface EngineMargin {
  engine: string;
  calls: number;
  totalTokens: number;
  revenueCredits: number;
  costCredits: number;
  marginCredits: number;
  marginPct: number;
}

export interface PlatformAiMarginView {
  perEngine: EngineMargin[];
  totals: {
    calls: number;
    totalTokens: number;
    revenueCredits: number;
    costCredits: number;
    marginCredits: number;
    marginPct: number;
  };
  /** Actual paid top-up revenue in whole Rupiah (Σ token-addon payments). */
  revenueIdr: number;
  /** Ledger reconciliation: should tie out against perEngine revenueCredits. */
  reconciliation: {
    usageCredits: number;
    topupCredits: number;
    grantCredits: number;
    expireCredits: number;
  };
}

function pct(margin: number, revenue: number): number {
  if (revenue <= 0) return 0;
  return Math.round((margin / revenue) * 100);
}

/** Sum of paid top-up revenue in Rupiah, attributing only the token-addon
 * portion of each payment (single addon payments + token lines inside carts). */
async function sumTokenTopupIdr(tokenAddonIds: number[]): Promise<number> {
  if (tokenAddonIds.length === 0) return 0;
  const tokenSet = new Set(tokenAddonIds);

  // Single-item token-addon payments: the whole amount is a top-up.
  const [single] = await db
    .select({ total: sql<number>`coalesce(sum(${paymentsTable.amountIdr}), 0)::int` })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.status, "paid"),
        eq(paymentsTable.kind, "addon"),
        inArray(paymentsTable.refId, tokenAddonIds),
      ),
    );

  // Cart payments may bundle a token top-up with other items: attribute only the
  // token line amounts.
  const carts = await db
    .select({ lineItems: paymentsTable.lineItems })
    .from(paymentsTable)
    .where(and(eq(paymentsTable.status, "paid"), eq(paymentsTable.kind, "cart"), isNotNull(paymentsTable.lineItems)));

  let cartTotal = 0;
  for (const c of carts) {
    for (const li of c.lineItems ?? []) {
      if (li.kind === "addon" && tokenSet.has(li.refId)) cartTotal += li.lineAmountIdr;
    }
  }

  return (single?.total ?? 0) + cartTotal;
}

/** Compute the platform AI margin + reconciliation view. */
export async function getPlatformAiMargin(): Promise<PlatformAiMarginView> {
  // Per-engine usage aggregates (only rows that named a platform engine).
  const usageRows = await db
    .select({
      engine: aiUsageEventsTable.engine,
      calls: sql<number>`count(*)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEventsTable.totalTokens}), 0)::int`,
      revenueCredits: sql<number>`coalesce(sum(${aiUsageEventsTable.creditsCharged}), 0)::int`,
    })
    .from(aiUsageEventsTable)
    .where(isNotNull(aiUsageEventsTable.engine))
    .groupBy(aiUsageEventsTable.engine);

  // Current per-engine credit rate (un-marked-up base = provider-cost proxy).
  const engineRates = await db
    .select({ engine: platformAiEngineTable.engine, rate: platformAiEngineTable.creditPer1kToken })
    .from(platformAiEngineTable);
  const rateByEngine = new Map(engineRates.map((e) => [e.engine, e.rate]));

  const perEngine: EngineMargin[] = usageRows
    .filter((r) => r.engine)
    .map((r) => {
      const engine = r.engine as string;
      const rate = rateByEngine.get(engine) ?? 1000;
      const costCredits = Math.round((r.totalTokens / 1000) * rate);
      const marginCredits = r.revenueCredits - costCredits;
      return {
        engine,
        calls: r.calls,
        totalTokens: r.totalTokens,
        revenueCredits: r.revenueCredits,
        costCredits,
        marginCredits,
        marginPct: pct(marginCredits, r.revenueCredits),
      };
    })
    .sort((a, b) => b.revenueCredits - a.revenueCredits);

  const totals = perEngine.reduce(
    (acc, e) => {
      acc.calls += e.calls;
      acc.totalTokens += e.totalTokens;
      acc.revenueCredits += e.revenueCredits;
      acc.costCredits += e.costCredits;
      acc.marginCredits += e.marginCredits;
      return acc;
    },
    { calls: 0, totalTokens: 0, revenueCredits: 0, costCredits: 0, marginCredits: 0, marginPct: 0 },
  );
  totals.marginPct = pct(totals.marginCredits, totals.revenueCredits);

  // Ledger reconciliation (credits in/out by reason).
  const ledgerRows = await db
    .select({
      reason: creditLedgerTable.reason,
      total: sql<number>`coalesce(sum(${creditLedgerTable.delta}), 0)::int`,
    })
    .from(creditLedgerTable)
    .groupBy(creditLedgerTable.reason);
  const byReason = new Map(ledgerRows.map((r) => [r.reason, r.total]));

  const tokenAddonIds = (
    await db.select({ id: addonsTable.id }).from(addonsTable).where(eq(addonsTable.type, "token"))
  ).map((r) => r.id);
  const revenueIdr = await sumTokenTopupIdr(tokenAddonIds);

  return {
    perEngine,
    totals,
    revenueIdr,
    reconciliation: {
      usageCredits: Math.abs(byReason.get("usage") ?? 0),
      topupCredits: byReason.get("topup") ?? 0,
      grantCredits: byReason.get("grant") ?? 0,
      expireCredits: Math.abs(byReason.get("expire") ?? 0),
    },
  };
}

export async function getPlatformAiMarginSafe(): Promise<PlatformAiMarginView> {
  try {
    return await getPlatformAiMargin();
  } catch (err) {
    logger.error({ err }, "getPlatformAiMargin failed");
    return {
      perEngine: [],
      totals: { calls: 0, totalTokens: 0, revenueCredits: 0, costCredits: 0, marginCredits: 0, marginPct: 0 },
      revenueIdr: 0,
      reconciliation: { usageCredits: 0, topupCredits: 0, grantCredits: 0, expireCredits: 0 },
    };
  }
}
