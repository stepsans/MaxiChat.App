import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMonthlyBill,
  computeEffectiveStatus,
  isReadOnlySubscription,
  addMonths,
} from "./billing-engine";

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

// ----- computeEffectiveStatus -----

const NOW = new Date("2026-06-06T00:00:00.000Z");

test("active within period stays active", () => {
  assert.equal(
    computeEffectiveStatus("active", "2026-07-06T00:00:00.000Z", NOW),
    "active"
  );
});

test("trial within period stays trial", () => {
  assert.equal(
    computeEffectiveStatus("trial", "2026-06-13T00:00:00.000Z", NOW),
    "trial"
  );
});

test("active past period end collapses to expired", () => {
  assert.equal(
    computeEffectiveStatus("active", "2026-06-05T23:59:59.000Z", NOW),
    "expired"
  );
});

test("trial past period end collapses to expired", () => {
  assert.equal(
    computeEffectiveStatus("trial", "2026-05-30T00:00:00.000Z", NOW),
    "expired"
  );
});

test("suspended is sticky regardless of a future period end", () => {
  assert.equal(
    computeEffectiveStatus("suspended", "2026-12-31T00:00:00.000Z", NOW),
    "suspended"
  );
});

test("stored expired stays expired", () => {
  assert.equal(
    computeEffectiveStatus("expired", "2026-12-31T00:00:00.000Z", NOW),
    "expired"
  );
});

test("null period end keeps active/trial alive", () => {
  assert.equal(computeEffectiveStatus("active", null, NOW), "active");
  assert.equal(computeEffectiveStatus("trial", null, NOW), "trial");
});

test("unknown stored status is treated as expired", () => {
  assert.equal(computeEffectiveStatus("frozen", null, NOW), "expired");
});

// exactly AT the boundary is still active (period end is exclusive upper, but
// equality means "not yet past"), one ms later is expired.
test("period boundary is inclusive of the end instant", () => {
  const end = "2026-06-06T00:00:00.000Z";
  assert.equal(computeEffectiveStatus("active", end, NOW), "active");
  assert.equal(
    computeEffectiveStatus(
      "active",
      end,
      new Date("2026-06-06T00:00:00.001Z")
    ),
    "expired"
  );
});

// ----- isReadOnlySubscription -----

test("expired and suspended are read-only; trial and active are not", () => {
  assert.equal(isReadOnlySubscription("expired"), true);
  assert.equal(isReadOnlySubscription("suspended"), true);
  assert.equal(isReadOnlySubscription("trial"), false);
  assert.equal(isReadOnlySubscription("active"), false);
});

// ----- addMonths -----

test("addMonths advances one month keeping the day", () => {
  assert.equal(
    addMonths(new Date("2026-06-06T00:00:00.000Z"), 1).toISOString(),
    "2026-07-06T00:00:00.000Z"
  );
});

test("addMonths clamps to the last day of a shorter month", () => {
  // Jan 31 + 1 month -> Feb 28 (2026 is not a leap year)
  assert.equal(
    addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(),
    "2026-02-28T00:00:00.000Z"
  );
});

test("addMonths rolls over the year boundary", () => {
  assert.equal(
    addMonths(new Date("2026-12-15T00:00:00.000Z"), 1).toISOString(),
    "2027-01-15T00:00:00.000Z"
  );
});

test("addMonths handles multi-month extension", () => {
  assert.equal(
    addMonths(new Date("2026-06-06T00:00:00.000Z"), 3).toISOString(),
    "2026-09-06T00:00:00.000Z"
  );
});
