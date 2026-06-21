import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeUsagePercent,
  computeNotifyLevel,
  computeProjectedDaysRemaining,
  notifyLevelRank,
} from "./ai-usage-build";

test("notifyLevelRank orders by severity for escalation checks", () => {
  assert.ok(notifyLevelRank("ok") < notifyLevelRank("warn80"));
  assert.ok(notifyLevelRank("warn80") < notifyLevelRank("crit5"));
  assert.ok(notifyLevelRank("crit5") < notifyLevelRank("depleted"));
});

test("usagePercent clamps and rounds", () => {
  assert.equal(computeUsagePercent(10_000, 8_200), 82);
  assert.equal(computeUsagePercent(10_000, 0), 0);
  assert.equal(computeUsagePercent(10_000, 99_999), 100);
  // Uncapped (limit<=0) is never depleted.
  assert.equal(computeUsagePercent(0, 5_000), 0);
});

test("notifyLevel escalates by remaining quota", () => {
  assert.equal(computeNotifyLevel(10_000, 0), "ok");
  assert.equal(computeNotifyLevel(10_000, 7_900), "ok"); // 21% left
  assert.equal(computeNotifyLevel(10_000, 8_000), "warn80"); // exactly 20% left
  assert.equal(computeNotifyLevel(10_000, 9_500), "crit5"); // 5% left
  assert.equal(computeNotifyLevel(10_000, 9_960), "crit5"); // <5% left
  assert.equal(computeNotifyLevel(10_000, 10_000), "depleted");
  assert.equal(computeNotifyLevel(10_000, 12_000), "depleted");
  // Uncapped never warns.
  assert.equal(computeNotifyLevel(0, 99_999), "ok");
});

test("projectedDaysRemaining estimates from burn rate", () => {
  const periodStart = new Date("2026-06-01T00:00:00Z");
  const now = new Date("2026-06-11T00:00:00Z"); // 10 days elapsed
  // 2000 used over 10 days = 200/day; 8000 remaining → 40 days.
  assert.equal(
    computeProjectedDaysRemaining({ tokenLimit: 10_000, tokenUsed: 2_000, periodStart, now }),
    40
  );
  // No usage yet → null.
  assert.equal(
    computeProjectedDaysRemaining({ tokenLimit: 10_000, tokenUsed: 0, periodStart, now }),
    null
  );
  // Uncapped → null.
  assert.equal(
    computeProjectedDaysRemaining({ tokenLimit: 0, tokenUsed: 500, periodStart, now }),
    null
  );
  // Already depleted → null.
  assert.equal(
    computeProjectedDaysRemaining({ tokenLimit: 10_000, tokenUsed: 10_000, periodStart, now }),
    null
  );
});
