import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthlyCloseLines,
  monthlyCloseInvoiceNumber,
  type AddonPricingByType,
  type MonthlyClosePlan,
  type MonthlyCloseQuota,
} from "./monthly-close-build";
import { invoiceTotals } from "./invoice-build";

const PLAN: MonthlyClosePlan = {
  id: 3,
  name: "Paket Growth",
  priceIdr: 300_000,
  quotaTokens: 100_000,
  quotaChannels: 2,
  quotaUsers: 5,
  quotaStorageBytes: 10_000,
};

const ADDONS: AddonPricingByType = {
  token: { id: 11, name: "Token Booster", unitAmount: 100_000, priceIdr: 50_000 },
  channel: { id: 12, name: "Channel Slot", unitAmount: 1, priceIdr: 75_000 },
  user_seat: { id: 13, name: "User Seat", unitAmount: 1, priceIdr: 25_000 },
  storage: { id: 14, name: "Storage 10GB", unitAmount: 10_000, priceIdr: 40_000 },
};

test("monthlyCloseInvoiceNumber: deterministic per (owner, period), MC-segmented", () => {
  const n = monthlyCloseInvoiceNumber(10, new Date("2026-06-14T00:00:00Z"));
  assert.equal(n, "INV-2026-MC-10-06");
  // Same inputs → same number (the period-idempotency guard).
  assert.equal(monthlyCloseInvoiceNumber(10, new Date("2026-06-14T00:00:00Z")), n);
  // Different owner / month / year produce distinct numbers.
  assert.notEqual(n, monthlyCloseInvoiceNumber(11, new Date("2026-06-14T00:00:00Z")));
  assert.notEqual(n, monthlyCloseInvoiceNumber(10, new Date("2026-07-14T00:00:00Z")));
  assert.equal(
    monthlyCloseInvoiceNumber(10, new Date("2025-01-31T00:00:00Z")),
    "INV-2025-MC-10-01"
  );
});

test("buildMonthlyCloseLines: plan only when quota equals the plan base", () => {
  const quota: MonthlyCloseQuota = {
    tokenLimit: PLAN.quotaTokens,
    channelLimit: PLAN.quotaChannels,
    userLimit: PLAN.quotaUsers,
    storageLimit: PLAN.quotaStorageBytes,
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, ADDONS);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    lineType: "plan",
    refId: 3,
    description: "Paket Growth",
    quantity: 1,
    unitPriceIdr: 300_000,
    amountIdr: 300_000,
  });
  assert.equal(invoiceTotals(lines).totalIdr, 300_000);
});

test("buildMonthlyCloseLines: standing add-ons priced from quota deltas (token excluded — prepaid credit)", () => {
  const quota: MonthlyCloseQuota = {
    tokenLimit: 300_000, // delta IGNORED — token rides the prepaid wallet, not monthly_close
    channelLimit: 4, // +2 → 2 channel blocks
    userLimit: 8, // +3 → 3 seats
    storageLimit: 30_000, // +20k → 2 storage blocks
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, ADDONS);
  assert.equal(lines.length, 4); // plan + channel + seat + storage (NO token line)
  const byType = Object.fromEntries(lines.map((l) => [l.refId, l]));
  assert.equal(byType[11], undefined); // token add-on never billed here
  assert.equal(byType[12].quantity, 2);
  assert.equal(byType[12].amountIdr, 150_000);
  assert.equal(byType[13].quantity, 3);
  assert.equal(byType[13].amountIdr, 75_000);
  assert.equal(byType[14].quantity, 2);
  assert.equal(byType[14].amountIdr, 80_000);
  // 300k plan + 150k + 75k + 80k (token excluded)
  assert.equal(invoiceTotals(lines).totalIdr, 605_000);
});

test("buildMonthlyCloseLines: no add-on line when catalog has no matching add-on", () => {
  const quota: MonthlyCloseQuota = {
    tokenLimit: 300_000, // delta exists but no token add-on to price it
    channelLimit: PLAN.quotaChannels,
    userLimit: PLAN.quotaUsers,
    storageLimit: PLAN.quotaStorageBytes,
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineType, "plan");
});

test("buildMonthlyCloseLines: non-multiple deltas bill only WHOLE blocks (floor, never round up)", () => {
  // Storage add-on (id 14): unitAmount 10_000, priceIdr 40_000.
  const quota: MonthlyCloseQuota = {
    tokenLimit: PLAN.quotaTokens,
    channelLimit: PLAN.quotaChannels,
    userLimit: PLAN.quotaUsers,
    storageLimit: PLAN.quotaStorageBytes + 15_000, // +15k → 1 whole 10k block (floor), remainder dropped
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, ADDONS);
  assert.equal(lines.length, 2);
  const storage = lines.find((l) => l.refId === 14)!;
  assert.equal(storage.quantity, 1); // floor(15000/10000), not round → 2
  assert.equal(storage.amountIdr, 40_000);
});

test("buildMonthlyCloseLines: a delta below one whole block emits no line", () => {
  const quota: MonthlyCloseQuota = {
    tokenLimit: PLAN.quotaTokens,
    channelLimit: PLAN.quotaChannels,
    userLimit: PLAN.quotaUsers,
    storageLimit: PLAN.quotaStorageBytes + 5_000, // +5k < 10k block → no line (floor → 0)
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, ADDONS);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineType, "plan");
});

test("buildMonthlyCloseLines: negative/zero deltas never emit a line", () => {
  const quota: MonthlyCloseQuota = {
    tokenLimit: PLAN.quotaTokens,
    channelLimit: PLAN.quotaChannels,
    userLimit: PLAN.quotaUsers,
    storageLimit: PLAN.quotaStorageBytes - 50_000, // below base (shouldn't happen, guard anyway)
  };
  const lines = buildMonthlyCloseLines(PLAN, quota, ADDONS);
  assert.equal(lines.length, 1);
});
