import { test } from "node:test";
import assert from "node:assert/strict";
import {
  storagePercent,
  hardLimitBytes,
  isStorageWritable,
  computeStorageStatus,
} from "./storage-quota";

test("storagePercent: non-positive limit is 0%", () => {
  assert.equal(storagePercent(100, 0), 0);
  assert.equal(storagePercent(100, -5), 0);
});

test("storagePercent: rounds to whole percent", () => {
  assert.equal(storagePercent(50, 100), 50);
  assert.equal(storagePercent(1, 3), 33);
  assert.equal(storagePercent(2, 3), 67);
});

test("hardLimitBytes: grace adds floored slack above the plafon", () => {
  assert.equal(hardLimitBytes(1000, 0), 1000);
  assert.equal(hardLimitBytes(1000, 10), 1100);
  // floored: 10% of 999 = 99.9 -> 99
  assert.equal(hardLimitBytes(999, 10), 1098);
  // negative grace clamped to 0
  assert.equal(hardLimitBytes(1000, -50), 1000);
  // non-positive limit -> 0
  assert.equal(hardLimitBytes(0, 10), 0);
});

test("isStorageWritable: non-positive limit is always writable", () => {
  assert.equal(isStorageWritable(999999, 1000, 0, 0), true);
  assert.equal(isStorageWritable(999999, 1000, -1, 0), true);
});

test("isStorageWritable: blocks once used+incoming exceeds the hard limit", () => {
  // exactly at the limit is allowed
  assert.equal(isStorageWritable(900, 100, 1000, 0), true);
  // one byte over the limit is blocked (no grace)
  assert.equal(isStorageWritable(900, 101, 1000, 0), false);
  // grace gives slack: hard limit = 1100
  assert.equal(isStorageWritable(1000, 100, 1000, 10), true);
  assert.equal(isStorageWritable(1000, 101, 1000, 10), false);
});

test("computeStorageStatus: ok below warn", () => {
  const s = computeStorageStatus({
    usedBytes: 500,
    limitBytes: 1000,
    warnPercent: 80,
    gracePercent: 0,
  });
  assert.equal(s.percent, 50);
  assert.equal(s.level, "ok");
  assert.equal(s.hardLimitBytes, 1000);
});

test("computeStorageStatus: warn at/above the warn threshold", () => {
  const s = computeStorageStatus({
    usedBytes: 800,
    limitBytes: 1000,
    warnPercent: 80,
    gracePercent: 0,
  });
  assert.equal(s.percent, 80);
  assert.equal(s.level, "warn");
});

test("computeStorageStatus: over once past the hard limit (incl. grace)", () => {
  // at 100% but within grace -> still warn, not over
  const within = computeStorageStatus({
    usedBytes: 1050,
    limitBytes: 1000,
    warnPercent: 80,
    gracePercent: 10,
  });
  assert.equal(within.level, "warn");
  // past hard limit (1100) -> over
  const over = computeStorageStatus({
    usedBytes: 1200,
    limitBytes: 1000,
    warnPercent: 80,
    gracePercent: 10,
  });
  assert.equal(over.level, "over");
});

test("computeStorageStatus: no plafon is always ok", () => {
  const s = computeStorageStatus({
    usedBytes: 999999,
    limitBytes: 0,
    warnPercent: 80,
    gracePercent: 0,
  });
  assert.equal(s.percent, 0);
  assert.equal(s.level, "ok");
});
