import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysSinceActivity,
  isHighRisk,
  computePipelineHealth,
  type PipelineHealthConfig,
  type PipelineHealthOpportunity,
} from "./pipeline-health-build";

const NOW = new Date(2026, 0, 30); // 2026-01-30
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const cfg: PipelineHealthConfig = {
  staleDaysThreshold: 14,
  highValueThresholdIdr: 1_000_000,
};

function opp(
  over: Partial<PipelineHealthOpportunity> & { id: number }
): PipelineHealthOpportunity {
  return {
    status: "open",
    estimatedValueIdr: 5_000_000,
    lastActivityAt: daysAgo(20),
    ...over,
  };
}

test("daysSinceActivity floors whole days", () => {
  assert.equal(daysSinceActivity(NOW, daysAgo(0)), 0);
  assert.equal(daysSinceActivity(NOW, daysAgo(14)), 14);
  // 13.5 days ago → floor → 13
  assert.equal(
    daysSinceActivity(NOW, new Date(NOW.getTime() - 13.5 * 24 * 60 * 60 * 1000)),
    13
  );
});

test("null last-activity is treated as infinitely stale", () => {
  assert.equal(daysSinceActivity(NOW, null), Number.POSITIVE_INFINITY);
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: null }), cfg, NOW), true);
});

test("future last-activity is never stale", () => {
  assert.equal(daysSinceActivity(NOW, daysAgo(-3)), -3);
  assert.equal(
    isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(-3) }), cfg, NOW),
    false
  );
});

test("staleness threshold is inclusive at the boundary", () => {
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(13) }), cfg, NOW), false);
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(14) }), cfg, NOW), true);
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(15) }), cfg, NOW), true);
});

test("value threshold is inclusive at the boundary", () => {
  assert.equal(isHighRisk(opp({ id: 1, estimatedValueIdr: 999_999 }), cfg, NOW), false);
  assert.equal(isHighRisk(opp({ id: 1, estimatedValueIdr: 1_000_000 }), cfg, NOW), true);
});

test("closed deals (won/lost) are never high risk", () => {
  assert.equal(isHighRisk(opp({ id: 1, status: "won" }), cfg, NOW), false);
  assert.equal(isHighRisk(opp({ id: 1, status: "lost" }), cfg, NOW), false);
});

test("highValueThreshold 0 means only staleness matters", () => {
  const c: PipelineHealthConfig = { staleDaysThreshold: 14, highValueThresholdIdr: 0 };
  assert.equal(isHighRisk(opp({ id: 1, estimatedValueIdr: 0 }), c, NOW), true);
});

test("staleDaysThreshold clamps to >= 1 so fresh deals aren't all flagged", () => {
  const c: PipelineHealthConfig = { staleDaysThreshold: 0, highValueThresholdIdr: 0 };
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(0) }), c, NOW), false);
  assert.equal(isHighRisk(opp({ id: 1, lastActivityAt: daysAgo(1) }), c, NOW), true);
});

test("computePipelineHealth aggregates count + value and lists ids", () => {
  const result = computePipelineHealth(
    [
      opp({ id: 1, estimatedValueIdr: 2_000_000, lastActivityAt: daysAgo(20) }), // risk
      opp({ id: 2, estimatedValueIdr: 3_000_000, lastActivityAt: daysAgo(30) }), // risk
      opp({ id: 3, estimatedValueIdr: 500_000, lastActivityAt: daysAgo(30) }), // below value
      opp({ id: 4, estimatedValueIdr: 9_000_000, lastActivityAt: daysAgo(2) }), // fresh
      opp({ id: 5, status: "won", lastActivityAt: daysAgo(99) }), // closed
    ],
    cfg,
    NOW
  );
  assert.deepEqual(result.highRiskIds, [1, 2]);
  assert.equal(result.summary.highRiskCount, 2);
  assert.equal(result.summary.highRiskValueIdr, 5_000_000);
  assert.equal(result.summary.staleDaysThreshold, 14);
  assert.equal(result.summary.highValueThresholdIdr, 1_000_000);
});

test("computePipelineHealth normalizes config in the summary", () => {
  const result = computePipelineHealth([], { staleDaysThreshold: 0, highValueThresholdIdr: -5 }, NOW);
  assert.equal(result.summary.staleDaysThreshold, 1);
  assert.equal(result.summary.highValueThresholdIdr, 0);
  assert.deepEqual(result.highRiskIds, []);
});
