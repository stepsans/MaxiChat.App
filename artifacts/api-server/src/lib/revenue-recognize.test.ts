import { test } from "node:test";
import assert from "node:assert/strict";
import {
  windowDays,
  dailyRecognition,
  recognizedFromLine,
  recognizedInPeriod,
  monthlyNormalized,
  type RecognizableLine,
} from "./revenue-recognize";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day));

// An annual plan: 1,200,000 over ~365 days.
const annual: RecognizableLine = {
  amountIdr: 1_200_000,
  lineType: "plan",
  coversFrom: d(2026, 0, 1),
  coversTo: d(2026, 11, 31),
  issuedAt: d(2026, 0, 1),
};

const usage: RecognizableLine = {
  amountIdr: 50_000,
  lineType: "usage",
  coversFrom: null,
  coversTo: null,
  issuedAt: d(2026, 2, 15),
};

test("windowDays inclusive, min 1", () => {
  assert.equal(windowDays(d(2026, 0, 1), d(2026, 0, 31)), 30);
  assert.equal(windowDays(d(2026, 0, 1), d(2026, 0, 1)), 1);
});

test("dailyRecognition spreads over-time, immediate returns full", () => {
  assert.ok(dailyRecognition(annual) > 0);
  assert.ok(dailyRecognition(annual) < annual.amountIdr);
  assert.equal(dailyRecognition(usage), 50_000);
});

test("immediate line recognized only in its issue period", () => {
  assert.equal(
    recognizedFromLine(usage, d(2026, 2, 1), d(2026, 3, 1)),
    50_000
  );
  assert.equal(recognizedFromLine(usage, d(2026, 0, 1), d(2026, 1, 1)), 0);
});

test("over-time line splits across periods and sums to total", () => {
  // Sum monthly recognition across the whole year == full amount (tail picks
  // up the rounding remainder).
  let sum = 0;
  for (let m = 0; m < 12; m++) {
    const start = d(2026, m, 1);
    const end = m === 11 ? d(2027, 0, 1) : d(2026, m + 1, 1);
    sum += recognizedFromLine(annual, start, end);
  }
  assert.equal(sum, annual.amountIdr);
});

test("recognizedInPeriod aggregates many lines", () => {
  const total = recognizedInPeriod(
    [annual, usage],
    d(2026, 2, 1),
    d(2026, 3, 1)
  );
  assert.ok(total > 50_000); // usage full + one month of annual
});

test("monthlyNormalized: annual → ~monthly, immediate → 0", () => {
  const m = monthlyNormalized(annual);
  assert.ok(m > 90_000 && m < 110_000); // ~100k/mo
  assert.equal(monthlyNormalized(usage), 0);
});
