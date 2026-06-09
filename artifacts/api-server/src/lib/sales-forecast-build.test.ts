import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSalesForecast,
  type ForecastOpportunity,
  type ForecastStage,
} from "./sales-forecast-build";

const stages: ForecastStage[] = [
  { id: 1, name: "Baru" },
  { id: 2, name: "Negosiasi" },
];

function open(
  stageId: number | null,
  estimatedValueIdr: number,
  leadScore: number
): ForecastOpportunity {
  return { status: "open", stageId, estimatedValueIdr, leadScore };
}

describe("computeSalesForecast", () => {
  it("returns an all-zero snapshot for no opportunities", () => {
    const r = computeSalesForecast([], stages);
    assert.equal(r.openCount, 0);
    assert.equal(r.openValueIdr, 0);
    assert.equal(r.weightedForecastIdr, 0);
    assert.equal(r.wonCount, 0);
    assert.equal(r.lostCount, 0);
    assert.equal(r.wonValueIdr, 0);
    assert.equal(r.winRatePct, 0);
    // Both known stages render even with no deals; no unstaged bucket.
    assert.equal(r.byStage.length, 2);
    assert.deepEqual(
      r.byStage.map((b) => [b.stageName, b.count, b.valueIdr, b.weightedIdr]),
      [
        ["Baru", 0, 0, 0],
        ["Negosiasi", 0, 0, 0],
      ]
    );
  });

  it("weights open value by leadScore probability and rounds to whole Rupiah", () => {
    // 1_000_000 * 0.5 = 500_000 ; 333_333 * 0.3 = 99_999.9 -> 100_000 (round)
    const r = computeSalesForecast(
      [open(1, 1_000_000, 50), open(2, 333_333, 30)],
      stages
    );
    assert.equal(r.openCount, 2);
    assert.equal(r.openValueIdr, 1_333_333);
    assert.equal(r.weightedForecastIdr, 600_000);
    // Per-stage weighting + rounding.
    const baru = r.byStage.find((b) => b.stageId === 1)!;
    const nego = r.byStage.find((b) => b.stageId === 2)!;
    assert.equal(baru.weightedIdr, 500_000);
    assert.equal(nego.weightedIdr, 100_000);
    assert.equal(nego.valueIdr, 333_333);
  });

  it("clamps lead score: <=0 contributes nothing, >=100 contributes full value", () => {
    const r = computeSalesForecast(
      [open(1, 200_000, 0), open(1, 200_000, -10), open(2, 400_000, 130)],
      stages
    );
    // Only the >=100 deal contributes its full value.
    assert.equal(r.weightedForecastIdr, 400_000);
    assert.equal(r.openValueIdr, 800_000);
  });

  it("computes win rate from closed deals and ignores open ones", () => {
    const opps: ForecastOpportunity[] = [
      { status: "won", stageId: 2, estimatedValueIdr: 5_000_000, leadScore: 90 },
      { status: "won", stageId: 2, estimatedValueIdr: 1_000_000, leadScore: 90 },
      { status: "lost", stageId: 1, estimatedValueIdr: 2_000_000, leadScore: 10 },
      open(1, 9_000_000, 50),
    ];
    const r = computeSalesForecast(opps, stages);
    assert.equal(r.wonCount, 2);
    assert.equal(r.lostCount, 1);
    assert.equal(r.wonValueIdr, 6_000_000);
    // 2 / 3 = 66.67 -> 67
    assert.equal(r.winRatePct, 67);
    // Won/lost deals never enter the open pipeline buckets.
    assert.equal(r.openCount, 1);
    assert.equal(r.openValueIdr, 9_000_000);
  });

  it("is zero win rate when nothing has closed", () => {
    const r = computeSalesForecast([open(1, 1_000_000, 50)], stages);
    assert.equal(r.winRatePct, 0);
  });

  it("groups open deals with no stage into a 'Tanpa Stage' bucket only when present", () => {
    const r = computeSalesForecast(
      [open(null, 1_000_000, 100), open(1, 500_000, 100)],
      stages
    );
    const unstaged = r.byStage.find((b) => b.stageId === null);
    assert.ok(unstaged, "unstaged bucket should be appended");
    assert.equal(unstaged!.stageName, "Tanpa Stage");
    assert.equal(unstaged!.count, 1);
    assert.equal(unstaged!.valueIdr, 1_000_000);
    assert.equal(unstaged!.weightedIdr, 1_000_000);
  });

  it("folds open deals referencing an unknown stage id into a bucket (never drops value)", () => {
    const r = computeSalesForecast([open(999, 750_000, 100)], stages);
    const total = r.byStage.reduce((s, b) => s + b.valueIdr, 0);
    assert.equal(total, 750_000);
    assert.equal(r.openValueIdr, 750_000);
  });

  it("treats non-finite values defensively as zero", () => {
    const r = computeSalesForecast(
      [open(1, Number.NaN, 50), open(1, 1_000_000, Number.NaN)],
      stages
    );
    assert.equal(r.openValueIdr, 1_000_000);
    // First deal has NaN value (->0); second has NaN score (prob 0).
    assert.equal(r.weightedForecastIdr, 0);
  });
});
