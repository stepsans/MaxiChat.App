import { test } from "node:test";
import assert from "node:assert/strict";
import { prorationFactor, buildProrationLines } from "./proration-build";

const start = new Date(2026, 0, 1);
const end = new Date(2026, 0, 31); // 30-day span
const mid = new Date(2026, 0, 16); // 15 days remaining

test("prorationFactor clamps to [0,1]", () => {
  assert.equal(prorationFactor(start, start, end), 1);
  assert.equal(prorationFactor(end, start, end), 0);
  assert.equal(prorationFactor(new Date(2027, 0, 1), start, end), 0);
  assert.equal(prorationFactor(new Date(2025, 0, 1), start, end), 1);
  assert.ok(Math.abs(prorationFactor(mid, start, end) - 0.5) < 0.01);
});

test("upgrade → net charge, both lines", () => {
  const r = buildProrationLines(
    100000,
    200000,
    "Plan Basic",
    "Plan Pro",
    mid,
    start,
    end
  );
  // factor ~0.5 → credit ~50000, charge ~100000, net ~+50000
  assert.equal(r.lines.length, 2);
  assert.ok(r.netIdr > 0);
  const credit = r.lines.find((l) => l.lineType === "proration_credit");
  const charge = r.lines.find((l) => l.lineType === "proration_charge");
  assert.ok(credit && credit.amountIdr < 0);
  assert.ok(charge && charge.amountIdr > 0);
});

test("downgrade → net negative (wallet credit)", () => {
  const r = buildProrationLines(
    200000,
    100000,
    "Plan Pro",
    "Plan Basic",
    mid,
    start,
    end
  );
  assert.ok(r.netIdr < 0);
});

test("pure addition (oldPrice 0) → only charge line", () => {
  const r = buildProrationLines(0, 50000, "", "Add seat", mid, start, end);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].lineType, "proration_charge");
  assert.ok(r.netIdr > 0);
});

test("pure removal (newPrice 0) → only credit line, net negative", () => {
  const r = buildProrationLines(50000, 0, "Remove seat", "", mid, start, end);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].lineType, "proration_credit");
  assert.ok(r.netIdr < 0);
});
