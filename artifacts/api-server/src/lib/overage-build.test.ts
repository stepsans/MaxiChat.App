import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOverageLines,
  computeTokenOverageLine,
  computeStorageOverageLine,
  OVERAGE_DISABLED,
  type OverageRates,
} from "./overage-build";

const GB = 1024 * 1024 * 1024;
const ENABLED: OverageRates = {
  enabled: true,
  tokenUnit: 100,
  tokenUnitPriceIdr: 500,
  storageGbDayPriceIdr: 100,
};

test("disabled rates → no overage lines", () => {
  assert.equal(
    computeOverageLines(
      {
        tokenUsed: 100000,
        tokenLimit: 0,
        avgStorageBytes: 100 * GB,
        storageLimitBytes: 0,
        periodDays: 30,
      },
      OVERAGE_DISABLED
    ).length,
    0
  );
});

test("token under plafon → no line", () => {
  assert.equal(
    computeTokenOverageLine({ tokenUsed: 90, tokenLimit: 100 }, ENABLED),
    null
  );
});

test("token overage charges whole blocks (floor)", () => {
  // 250 over plafon, block 100 → 2 blocks × 500 = 1000 (50 remainder dropped)
  const line = computeTokenOverageLine(
    { tokenUsed: 1250, tokenLimit: 1000 },
    ENABLED
  );
  assert.ok(line);
  assert.equal(line.quantity, 2);
  assert.equal(line.amountIdr, 1000);
  assert.equal(line.lineType, "usage");
});

test("storage overage uses GB-days", () => {
  // 2 GB over plafon for 30 days = 60 GB-days × 100 = 6000
  const line = computeStorageOverageLine(
    { avgStorageBytes: 12 * GB, storageLimitBytes: 10 * GB, periodDays: 30 },
    ENABLED
  );
  assert.ok(line);
  assert.equal(line.quantity, 60);
  assert.equal(line.amountIdr, 6000);
});

test("storage under plafon → no line", () => {
  assert.equal(
    computeStorageOverageLine(
      { avgStorageBytes: 5 * GB, storageLimitBytes: 10 * GB, periodDays: 30 },
      ENABLED
    ),
    null
  );
});

test("both components combine", () => {
  const lines = computeOverageLines(
    {
      tokenUsed: 1250,
      tokenLimit: 1000,
      avgStorageBytes: 12 * GB,
      storageLimitBytes: 10 * GB,
      periodDays: 30,
    },
    ENABLED
  );
  assert.equal(lines.length, 2);
});
