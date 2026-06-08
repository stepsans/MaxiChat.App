import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mrrFromInvoices,
  dailyRevenueTrendFromInvoices,
  type RevenueInvoiceInput,
} from "./revenue-build";

function inv(
  userId: number,
  source: string,
  totalIdr: number,
  issuedAt: string
): RevenueInvoiceInput {
  return { userId, source, totalIdr, issuedAt: new Date(issuedAt) };
}

test("mrrFromInvoices: sums latest monthly_close per active owner", () => {
  const invoices = [
    inv(1, "monthly_close", 100_000, "2026-01-01T00:00:00Z"),
    inv(1, "monthly_close", 150_000, "2026-02-01T00:00:00Z"), // newer wins
    inv(2, "monthly_close", 200_000, "2026-02-01T00:00:00Z"),
  ];
  // 150k (owner 1 latest) + 200k (owner 2) = 350k
  assert.equal(mrrFromInvoices(invoices, [1, 2]), 350_000);
});

test("mrrFromInvoices: ignores payment (one-off) invoices", () => {
  const invoices = [
    inv(1, "monthly_close", 100_000, "2026-02-01T00:00:00Z"),
    inv(1, "payment", 999_999, "2026-02-15T00:00:00Z"), // one-off, excluded
  ];
  assert.equal(mrrFromInvoices(invoices, [1]), 100_000);
});

test("mrrFromInvoices: excludes non-active owners", () => {
  const invoices = [
    inv(1, "monthly_close", 100_000, "2026-02-01T00:00:00Z"),
    inv(2, "monthly_close", 200_000, "2026-02-01T00:00:00Z"), // not active
  ];
  assert.equal(mrrFromInvoices(invoices, [1]), 100_000);
});

test("mrrFromInvoices: active owner with no monthly_close contributes 0", () => {
  const invoices = [inv(1, "monthly_close", 100_000, "2026-02-01T00:00:00Z")];
  // Owner 2 active but has no monthly_close invoice → 0 contribution.
  assert.equal(mrrFromInvoices(invoices, [1, 2]), 100_000);
});

test("mrrFromInvoices: empty inputs → 0", () => {
  assert.equal(mrrFromInvoices([], [1, 2]), 0);
  assert.equal(mrrFromInvoices([inv(1, "monthly_close", 5, "2026-02-01Z")], []), 0);
});

test("dailyRevenueTrendFromInvoices: groups by UTC issue day, oldest-first", () => {
  const rows = [
    { issuedAt: new Date("2026-02-01T03:00:00Z"), totalIdr: 100 },
    { issuedAt: new Date("2026-02-01T20:00:00Z"), totalIdr: 50 }, // same day
    { issuedAt: new Date("2026-02-03T10:00:00Z"), totalIdr: 200 },
  ];
  const trend = dailyRevenueTrendFromInvoices(rows, "2026-02-01");
  assert.deepEqual(
    trend.map((p) => ({ date: p.date, total: p.totalCharge })),
    [
      { date: "2026-02-01", total: 150 },
      { date: "2026-02-03", total: 200 },
    ]
  );
});

test("dailyRevenueTrendFromInvoices: excludes days before sinceDate", () => {
  const rows = [
    { issuedAt: new Date("2026-01-20T10:00:00Z"), totalIdr: 999 }, // before window
    { issuedAt: new Date("2026-02-02T10:00:00Z"), totalIdr: 300 },
  ];
  const trend = dailyRevenueTrendFromInvoices(rows, "2026-02-01");
  assert.equal(trend.length, 1);
  assert.equal(trend[0].date, "2026-02-02");
  assert.equal(trend[0].totalCharge, 300);
});

test("dailyRevenueTrendFromInvoices: breakdown fields are zeroed", () => {
  const trend = dailyRevenueTrendFromInvoices(
    [{ issuedAt: new Date("2026-02-02T10:00:00Z"), totalIdr: 300 }],
    "2026-02-01"
  );
  assert.equal(trend[0].dbCharge, 0);
  assert.equal(trend[0].userCharge, 0);
  assert.equal(trend[0].channelCharge, 0);
  assert.equal(trend[0].aiCharge, 0);
});
