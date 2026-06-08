// Pure, db-free invoice-building helpers (Billing v2 — FASE A). Kept free of
// any @workspace/db runtime import so they are unit-testable under the
// node:test runner (the db package connects eagerly on import). Only TYPE
// imports are used here — they are erased at runtime.
import type { PaymentRow } from "@workspace/db";

// A line to insert into invoice_line_items. Mirrors the table's writable shape.
export type InvoiceLineInput = {
  lineType: string;
  refId: number | null;
  description: string;
  quantity: number;
  unitPriceIdr: number;
  amountIdr: number;
};

// Deterministic, stable invoice number for a payment-derived invoice:
//   INV-<year>-<zero-padded payment id>
// Derived purely from the payment id + issue year, so settlement retries and
// the boot-time backfill always compute the SAME number (idempotent).
export function invoiceNumberForPayment(paymentId: number, issuedAt: Date): string {
  const year = issuedAt.getUTCFullYear();
  return `INV-${year}-${String(paymentId).padStart(6, "0")}`;
}

// Map a settled payment to invoice line inputs. Cart payments carry a snapshot
// `lineItems` array (prices fixed at checkout); legacy single-item rows
// (plan/addon/renewal with no lineItems) synthesize ONE line covering the whole
// amount so every paid payment yields a complete, balanced invoice.
export function invoiceLinesFromPayment(payment: PaymentRow): InvoiceLineInput[] {
  const items = payment.lineItems ?? [];
  if (items.length > 0) {
    return items.map((li) => ({
      lineType: li.kind,
      refId: li.refId ?? null,
      description: li.name,
      quantity: li.quantity,
      unitPriceIdr: li.unitPriceIdr,
      amountIdr: li.lineAmountIdr,
    }));
  }

  const label =
    payment.kind === "plan"
      ? "Paket langganan"
      : payment.kind === "addon"
        ? "Add-on"
        : payment.kind === "renewal"
          ? "Perpanjangan langganan"
          : "Pembelian";
  // quantity 1 / unit = total keeps integers exact (no division rounding) and
  // guarantees the synthesized line sums to the payment amount.
  return [
    {
      lineType: payment.kind === "renewal" ? "plan" : payment.kind || "other",
      refId: payment.refId ?? null,
      description: label,
      quantity: 1,
      unitPriceIdr: payment.amountIdr,
      amountIdr: payment.amountIdr,
    },
  ];
}

// Sum line amounts into invoice totals. Tax is 0 in FASE A (PPN is FASE G); the
// param keeps the contract ready without a signature change later.
export function invoiceTotals(
  lines: InvoiceLineInput[],
  taxIdr = 0
): { subtotalIdr: number; taxIdr: number; totalIdr: number } {
  const subtotalIdr = lines.reduce((sum, l) => sum + l.amountIdr, 0);
  return { subtotalIdr, taxIdr, totalIdr: subtotalIdr + taxIdr };
}
