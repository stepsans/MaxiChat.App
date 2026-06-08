import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRow } from "@workspace/db";
import {
  invoiceNumberForPayment,
  invoiceLinesFromPayment,
  invoiceTotals,
  computeInvoiceTotals,
  TAX_DISABLED,
  type InvoiceLineInput,
} from "./invoice-build";

// Minimal PaymentRow factory — only the fields the builders read matter; the
// rest are filled to satisfy the type without affecting behavior.
function makePayment(overrides: Partial<PaymentRow>): PaymentRow {
  return {
    id: 1,
    userId: 10,
    kind: "cart",
    refId: null,
    quantity: 1,
    amountIdr: 0,
    status: "paid",
    provider: "xendit",
    externalId: null,
    invoiceUrl: null,
    rawPayload: null,
    lineItems: null,
    paidAt: new Date("2026-06-08T00:00:00.000Z"),
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
    updatedAt: new Date("2026-06-08T00:00:00.000Z"),
    ...overrides,
  } as PaymentRow;
}

test("invoiceNumberForPayment: zero-padded, year-prefixed, deterministic", () => {
  const n1 = invoiceNumberForPayment(123, new Date("2026-06-08T00:00:00Z"));
  assert.equal(n1, "INV-2026-000123");
  // Same inputs → same number (idempotent backfill / retry).
  assert.equal(invoiceNumberForPayment(123, new Date("2026-06-08T00:00:00Z")), n1);
  // Year comes from the issue date.
  assert.equal(
    invoiceNumberForPayment(7, new Date("2025-12-31T23:00:00Z")),
    "INV-2025-000007"
  );
});

test("invoiceLinesFromPayment: cart maps snapshot line items 1:1", () => {
  const payment = makePayment({
    id: 5,
    kind: "cart",
    amountIdr: 350_000,
    lineItems: [
      {
        kind: "plan",
        refId: 2,
        quantity: 1,
        name: "Paket Growth",
        unitPriceIdr: 300_000,
        lineAmountIdr: 300_000,
      },
      {
        kind: "addon",
        refId: 9,
        quantity: 2,
        name: "Add-on User",
        unitPriceIdr: 25_000,
        lineAmountIdr: 50_000,
      },
    ],
  });
  const lines = invoiceLinesFromPayment(payment);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    lineType: "plan",
    refId: 2,
    description: "Paket Growth",
    quantity: 1,
    unitPriceIdr: 300_000,
    amountIdr: 300_000,
  });
  assert.equal(lines[1].lineType, "addon");
  assert.equal(lines[1].amountIdr, 50_000);
  // Totals balance against the snapshot prices.
  assert.deepEqual(invoiceTotals(lines), {
    subtotalIdr: 350_000,
    taxIdr: 0,
    totalIdr: 350_000,
  });
});

test("invoiceLinesFromPayment: legacy single-item row synthesizes one balanced line", () => {
  const payment = makePayment({
    id: 8,
    kind: "plan",
    refId: 3,
    quantity: 1,
    amountIdr: 100_000,
    lineItems: null,
  });
  const lines = invoiceLinesFromPayment(payment);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineType, "plan");
  assert.equal(lines[0].refId, 3);
  assert.equal(lines[0].quantity, 1);
  // unit = amount keeps integers exact and the line sums to the payment amount.
  assert.equal(lines[0].unitPriceIdr, 100_000);
  assert.equal(lines[0].amountIdr, 100_000);
  assert.equal(invoiceTotals(lines).totalIdr, 100_000);
});

test("invoiceLinesFromPayment: renewal maps to a 'plan' line", () => {
  const payment = makePayment({
    id: 9,
    kind: "renewal",
    refId: null,
    amountIdr: 300_000,
    lineItems: null,
  });
  const lines = invoiceLinesFromPayment(payment);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineType, "plan");
  assert.equal(lines[0].description, "Perpanjangan langganan");
  assert.equal(lines[0].amountIdr, 300_000);
});

test("invoiceTotals: empty lines yield zeros", () => {
  assert.deepEqual(invoiceTotals([]), {
    subtotalIdr: 0,
    taxIdr: 0,
    totalIdr: 0,
  });
});

const taxLines: InvoiceLineInput[] = [
  {
    lineType: "plan",
    refId: 1,
    description: "Paket",
    quantity: 1,
    unitPriceIdr: 111_000,
    amountIdr: 111_000,
  },
];

test("computeInvoiceTotals: disabled tax is a no-op (total == subtotal)", () => {
  assert.deepEqual(computeInvoiceTotals(taxLines, TAX_DISABLED), {
    subtotalIdr: 111_000,
    taxIdr: 0,
    totalIdr: 111_000,
  });
  // Default arg also means disabled.
  assert.deepEqual(computeInvoiceTotals(taxLines), {
    subtotalIdr: 111_000,
    taxIdr: 0,
    totalIdr: 111_000,
  });
});

test("computeInvoiceTotals: enabled but zero rate stays inert", () => {
  assert.deepEqual(
    computeInvoiceTotals(taxLines, {
      enabled: true,
      rateBps: 0,
      inclusive: true,
      label: "PPN",
    }),
    { subtotalIdr: 111_000, taxIdr: 0, totalIdr: 111_000 }
  );
});

test("computeInvoiceTotals: inclusive 11% decomposes without changing total", () => {
  const r = computeInvoiceTotals(taxLines, {
    enabled: true,
    rateBps: 1100,
    inclusive: true,
    label: "PPN",
  });
  // 111000 / 1.11 = 100000 exactly.
  assert.deepEqual(r, { subtotalIdr: 100_000, taxIdr: 11_000, totalIdr: 111_000 });
  // The collected total is preserved (key invariant for paid invoices).
  assert.equal(r.subtotalIdr + r.taxIdr, 111_000);
});

test("computeInvoiceTotals: exclusive 11% adds tax on top", () => {
  const r = computeInvoiceTotals(
    [
      {
        lineType: "plan",
        refId: 1,
        description: "Paket",
        quantity: 1,
        unitPriceIdr: 100_000,
        amountIdr: 100_000,
      },
    ],
    { enabled: true, rateBps: 1100, inclusive: false, label: "PPN" }
  );
  assert.deepEqual(r, { subtotalIdr: 100_000, taxIdr: 11_000, totalIdr: 111_000 });
});

test("computeInvoiceTotals: whole-Rupiah rounding (no fractional cents)", () => {
  const r = computeInvoiceTotals(
    [
      {
        lineType: "addon",
        refId: 2,
        description: "Add-on",
        quantity: 1,
        unitPriceIdr: 99_999,
        amountIdr: 99_999,
      },
    ],
    { enabled: true, rateBps: 1100, inclusive: true, label: "PPN" }
  );
  assert.ok(Number.isInteger(r.subtotalIdr));
  assert.ok(Number.isInteger(r.taxIdr));
  assert.equal(r.totalIdr, 99_999);
  assert.equal(r.subtotalIdr + r.taxIdr, 99_999);
});

test("computeInvoiceTotals: zero gross stays zero regardless of rate", () => {
  assert.deepEqual(
    computeInvoiceTotals([], {
      enabled: true,
      rateBps: 1100,
      inclusive: false,
      label: "PPN",
    }),
    { subtotalIdr: 0, taxIdr: 0, totalIdr: 0 }
  );
});
