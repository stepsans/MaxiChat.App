import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMonthlyBill } from "./billing-engine";

const PRICING = {
  dbPricePer500Mb: 50000,
  userPricePerUser: 50000,
  channelPricePer2: 50000,
  aiPricePer100Tokens: 50000,
};

const MB = 1024 * 1024;

test("zero usage bills nothing", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 0, childUserCount: 0, channelCount: 0, tokenUsage: 0 },
    PRICING
  );
  assert.deepEqual(bill, {
    dbCharge: 0,
    userCharge: 0,
    channelCharge: 0,
    aiCharge: 0,
    total: 0,
  });
});

test("any storage rounds up to a full 500MB bucket", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 1 * MB, childUserCount: 0, channelCount: 0, tokenUsage: 0 },
    PRICING
  );
  assert.equal(bill.dbCharge, 50000);
});

test("501MB needs two storage buckets", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 501 * MB, childUserCount: 0, channelCount: 0, tokenUsage: 0 },
    PRICING
  );
  assert.equal(bill.dbCharge, 100000);
});

test("exactly 500MB stays in one bucket", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 500 * MB, childUserCount: 0, channelCount: 0, tokenUsage: 0 },
    PRICING
  );
  assert.equal(bill.dbCharge, 50000);
});

test("child users bill linearly (parent excluded by caller)", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 0, childUserCount: 3, channelCount: 0, tokenUsage: 0 },
    PRICING
  );
  assert.equal(bill.userCharge, 150000);
});

test("channels bill in buckets of two, rounded up", () => {
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 2, tokenUsage: 0 },
      PRICING
    ).channelCharge,
    50000
  );
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 3, tokenUsage: 0 },
      PRICING
    ).channelCharge,
    100000
  );
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 6, tokenUsage: 0 },
      PRICING
    ).channelCharge,
    150000
  );
});

test("AI tokens bill per 100, rounded up", () => {
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 0, tokenUsage: 1 },
      PRICING
    ).aiCharge,
    50000
  );
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 0, tokenUsage: 100 },
      PRICING
    ).aiCharge,
    50000
  );
  assert.equal(
    computeMonthlyBill(
      { storageBytes: 0, childUserCount: 0, channelCount: 0, tokenUsage: 250 },
      PRICING
    ).aiCharge,
    150000
  );
});

test("total sums all four components", () => {
  const bill = computeMonthlyBill(
    {
      storageBytes: 600 * MB, // 2 buckets -> 100000
      childUserCount: 2, // 100000
      channelCount: 4, // 2 buckets -> 100000
      tokenUsage: 150, // 2 buckets -> 100000
    },
    PRICING
  );
  assert.equal(bill.dbCharge, 100000);
  assert.equal(bill.userCharge, 100000);
  assert.equal(bill.channelCharge, 100000);
  assert.equal(bill.aiCharge, 100000);
  assert.equal(bill.total, 400000);
});

test("custom pricing is respected", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 0, childUserCount: 1, channelCount: 0, tokenUsage: 0 },
    { ...PRICING, userPricePerUser: 75000 }
  );
  assert.equal(bill.userCharge, 75000);
});

test("non-positive bucket price disables that component, never divides by zero", () => {
  const bill = computeMonthlyBill(
    { storageBytes: 600 * MB, childUserCount: 0, channelCount: 0, tokenUsage: 0 },
    { ...PRICING, dbPricePer500Mb: 0 }
  );
  assert.equal(bill.dbCharge, 0);
});

test("negative usage is clamped to zero", () => {
  const bill = computeMonthlyBill(
    {
      storageBytes: -100,
      childUserCount: -3,
      channelCount: -2,
      tokenUsage: -50,
    },
    PRICING
  );
  assert.deepEqual(bill, {
    dbCharge: 0,
    userCharge: 0,
    channelCharge: 0,
    aiCharge: 0,
    total: 0,
  });
});
