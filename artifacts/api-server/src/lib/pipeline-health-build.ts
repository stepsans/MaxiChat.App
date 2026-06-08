// ===========================================================================
// AI Sales Assistant — Pipeline Health (db-free, unit-tested).
//
// Flags "High Risk" opportunities: open deals whose estimated value clears the
// tenant's high-value threshold AND that have gone stale (no activity for >=
// staleDaysThreshold days). Pure functions so the risk math is testable without
// the DB; the route layer (sales.ts) loads rows + settings and calls in.
//
// All money is whole-integer Rupiah.
// ===========================================================================

export type PipelineHealthConfig = {
  // An open deal needs >= this many days since its last activity to be stale.
  staleDaysThreshold: number;
  // An open deal needs estimated value >= this (whole Rupiah) to qualify.
  // 0 = the value axis never excludes anything (only staleness matters).
  highValueThresholdIdr: number;
};

// The opportunity shape the risk math needs. A subset of OpportunityRow so the
// caller can pass DB rows directly.
export type PipelineHealthOpportunity = {
  id: number;
  status: string;
  estimatedValueIdr: number;
  lastActivityAt: Date | null;
};

export type PipelineHealthSummary = {
  highRiskCount: number;
  highRiskValueIdr: number;
  staleDaysThreshold: number;
  highValueThresholdIdr: number;
};

export type PipelineHealthResult = {
  summary: PipelineHealthSummary;
  highRiskIds: number[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Whole days elapsed between `lastActivityAt` and `now`, floored. A null
// last-activity is treated as infinitely stale (Number.POSITIVE_INFINITY) so a
// deal that has never registered activity always trips the staleness axis. A
// future timestamp yields a negative number (never stale).
export function daysSinceActivity(
  now: Date,
  lastActivityAt: Date | null
): number {
  if (lastActivityAt == null) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - lastActivityAt.getTime()) / MS_PER_DAY);
}

// Is this a high-risk opportunity? Open status + value at/above the high-value
// threshold + stale at/beyond the staleness threshold. Closed (won/lost) deals
// are never at risk. staleDaysThreshold is clamped to >= 1 so a misconfigured 0
// can't flag every fresh deal.
export function isHighRisk(
  opp: PipelineHealthOpportunity,
  cfg: PipelineHealthConfig,
  now: Date
): boolean {
  if (opp.status !== "open") return false;
  const minValue = Math.max(0, cfg.highValueThresholdIdr);
  if (opp.estimatedValueIdr < minValue) return false;
  const staleDays = Math.max(1, cfg.staleDaysThreshold);
  return daysSinceActivity(now, opp.lastActivityAt) >= staleDays;
}

// Compute the pipeline-health summary + the set of high-risk opportunity ids
// from a list of (already tenant/role-scoped) opportunities.
export function computePipelineHealth(
  opportunities: ReadonlyArray<PipelineHealthOpportunity>,
  cfg: PipelineHealthConfig,
  now: Date
): PipelineHealthResult {
  const highRiskIds: number[] = [];
  let highRiskValueIdr = 0;
  for (const opp of opportunities) {
    if (isHighRisk(opp, cfg, now)) {
      highRiskIds.push(opp.id);
      highRiskValueIdr += opp.estimatedValueIdr;
    }
  }
  return {
    summary: {
      highRiskCount: highRiskIds.length,
      highRiskValueIdr,
      staleDaysThreshold: Math.max(1, cfg.staleDaysThreshold),
      highValueThresholdIdr: Math.max(0, cfg.highValueThresholdIdr),
    },
    highRiskIds,
  };
}
