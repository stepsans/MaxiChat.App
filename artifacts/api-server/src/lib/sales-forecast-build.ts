// ===========================================================================
// AI Sales Assistant — weighted revenue forecast (pure, db-free).
//
// Projects expected revenue from the OPEN pipeline by weighting each deal's
// estimated value by its lead-score probability (leadScore/100), and reports
// the realized win rate from closed deals. Kept db-free + side-effect-free so
// it can be unit-tested with node:test; the route feeds it already-scoped rows.
//
// All money is whole-integer Rupiah. Estimated values are integers by contract;
// the only place fractions appear is the probability multiply, so every money
// output is Math.round-ed back to a whole Rupiah.
// ===========================================================================

export type ForecastStatus = "open" | "won" | "lost";

export interface ForecastOpportunity {
  status: ForecastStatus;
  stageId: number | null;
  estimatedValueIdr: number;
  leadScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ForecastStage {
  id: number;
  name: string;
}

export interface ForecastStageBucket {
  stageId: number | null;
  stageName: string;
  count: number;
  valueIdr: number;
  weightedIdr: number;
}

export interface SalesForecastResult {
  openCount: number;
  openValueIdr: number;
  weightedForecastIdr: number;
  wonCount: number;
  lostCount: number;
  wonValueIdr: number;
  winRatePct: number;
  /** Average estimated value across open deals (0 when pipeline empty). */
  avgDealSizeIdr: number;
  /** Average days from opportunity creation to close (won or lost). 0 when no closed deals. */
  avgCycleDays: number;
  /** Sales velocity in Rupiah/day: (openCount × avgDealSize × winRate%) / avgCycleDays. 0 when cycle unknown. */
  salesVelocityIdr: number;
  byStage: ForecastStageBucket[];
}

// Label used for open deals that sit in no stage (stageId null). Mirrors the
// "Tanpa Stage" bucket the insights/board surfaces already use.
const NO_STAGE_LABEL = "Tanpa Stage";

// Probability for one deal: leadScore as a 0..1 fraction, clamped so a stray
// out-of-range score can never inflate or negate the forecast.
function probability(leadScore: number): number {
  if (!Number.isFinite(leadScore)) return 0;
  if (leadScore <= 0) return 0;
  if (leadScore >= 100) return 1;
  return leadScore / 100;
}

// Treat a missing/garbage estimate as 0 rather than NaN-poisoning the sums.
function safeValue(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function computeSalesForecast(
  opportunities: ForecastOpportunity[],
  stages: ForecastStage[],
): SalesForecastResult {
  let openCount = 0;
  let openValueIdr = 0;
  let weightedForecast = 0;
  let wonCount = 0;
  let lostCount = 0;
  let wonValueIdr = 0;
  let totalCycleDays = 0;
  let closedWithCycleCount = 0;

  // Per-stage accumulators for OPEN deals only (the board/forecast is about the
  // live pipeline). Seed every known stage so empty columns still render.
  const buckets = new Map<
    number | null,
    { count: number; valueIdr: number; weightedIdr: number }
  >();
  for (const s of stages) {
    buckets.set(s.id, { count: 0, valueIdr: 0, weightedIdr: 0 });
  }

  for (const opp of opportunities) {
    const value = safeValue(opp.estimatedValueIdr);
    if (opp.status === "won") {
      wonCount += 1;
      wonValueIdr += value;
      const cycleDays = (opp.updatedAt.getTime() - opp.createdAt.getTime()) / 86_400_000;
      if (cycleDays >= 0) {
        totalCycleDays += cycleDays;
        closedWithCycleCount += 1;
      }
      continue;
    }
    if (opp.status === "lost") {
      lostCount += 1;
      const cycleDays = (opp.updatedAt.getTime() - opp.createdAt.getTime()) / 86_400_000;
      if (cycleDays >= 0) {
        totalCycleDays += cycleDays;
        closedWithCycleCount += 1;
      }
      continue;
    }
    // open
    openCount += 1;
    openValueIdr += value;
    const weighted = value * probability(opp.leadScore);
    weightedForecast += weighted;

    const key = opp.stageId ?? null;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, valueIdr: 0, weightedIdr: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.valueIdr += value;
    bucket.weightedIdr += weighted;
  }

  const stageName = new Map<number, string>(stages.map((s) => [s.id, s.name]));
  const byStage: ForecastStageBucket[] = stages.map((s) => {
    const b = buckets.get(s.id) ?? { count: 0, valueIdr: 0, weightedIdr: 0 };
    return {
      stageId: s.id,
      stageName: s.name,
      count: b.count,
      valueIdr: b.valueIdr,
      weightedIdr: Math.round(b.weightedIdr),
    };
  });
  // Append the unstaged bucket only when it actually holds open deals, so we
  // don't render an empty "Tanpa Stage" column for tenants that always stage.
  const unstaged = buckets.get(null);
  if (unstaged && unstaged.count > 0) {
    byStage.push({
      stageId: null,
      stageName: NO_STAGE_LABEL,
      count: unstaged.count,
      valueIdr: unstaged.valueIdr,
      weightedIdr: Math.round(unstaged.weightedIdr),
    });
  }
  // Any open deal whose stageId references a stage that wasn't supplied falls
  // into a numeric bucket we never seeded; fold those in by their id so their
  // value is never silently dropped from the per-stage view.
  for (const [key, b] of buckets) {
    if (key === null) continue;
    if (stageName.has(key)) continue;
    if (b.count === 0) continue;
    byStage.push({
      stageId: key,
      stageName: NO_STAGE_LABEL,
      count: b.count,
      valueIdr: b.valueIdr,
      weightedIdr: Math.round(b.weightedIdr),
    });
  }

  const closed = wonCount + lostCount;
  const winRatePct = closed > 0 ? Math.round((wonCount / closed) * 100) : 0;

  const avgDealSizeIdr = openCount > 0 ? Math.round(openValueIdr / openCount) : 0;
  const avgCycleDays =
    closedWithCycleCount > 0 ? Math.round(totalCycleDays / closedWithCycleCount) : 0;
  const salesVelocityIdr =
    avgCycleDays > 0
      ? Math.round((openCount * avgDealSizeIdr * (winRatePct / 100)) / avgCycleDays)
      : 0;

  return {
    openCount,
    openValueIdr,
    weightedForecastIdr: Math.round(weightedForecast),
    wonCount,
    lostCount,
    wonValueIdr,
    winRatePct,
    avgDealSizeIdr,
    avgCycleDays,
    salesVelocityIdr,
    byStage,
  };
}
