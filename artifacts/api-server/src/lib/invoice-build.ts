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

// Tax (PPN) policy applied at invoice issue (Billing v2 — FASE G). Mirrors the
// tax_settings singleton row but kept as a plain type so this module stays
// db-free and unit-testable.
export type TaxConfig = {
  enabled: boolean;
  rateBps: number; // basis points, e.g. 1100 = 11%
  inclusive: boolean;
  label: string;
};

// The inert default: tax fully off, behavior identical to pre-FASE-G.
export const TAX_DISABLED: TaxConfig = {
  enabled: false,
  rateBps: 0,
  inclusive: true,
  label: "PPN",
};

// Compute subtotal/tax/total from line amounts under a tax policy, with
// whole-Rupiah rounding. Three regimes:
//
//   1. Disabled (or zero rate / zero gross): tax = 0, total = subtotal = sum.
//      Byte-for-byte the pre-FASE-G result.
//   2. Inclusive: the line amounts ALREADY include tax. Decompose so the total
//      is UNCHANGED (net = round(gross / (1 + rate))) — the customer pays
//      exactly the same; tax is only a breakdown. This is what payment-derived
//      invoices always use (the paid amount is the source of truth).
//   3. Exclusive: tax is ADDED on top of the net line amounts (total grows).
//      Only valid for unpaid bills (monthly_close), never for a collected
//      payment, where it would diverge from the ledgered amount.
export function computeInvoiceTotals(
  lines: InvoiceLineInput[],
  tax: TaxConfig = TAX_DISABLED
): { subtotalIdr: number; taxIdr: number; totalIdr: number } {
  const grossSum = lines.reduce((sum, l) => sum + l.amountIdr, 0);
  if (!tax.enabled || tax.rateBps <= 0 || grossSum <= 0) {
    return { subtotalIdr: grossSum, taxIdr: 0, totalIdr: grossSum };
  }
  if (tax.inclusive) {
    const net = Math.round((grossSum * 10000) / (10000 + tax.rateBps));
    return { subtotalIdr: net, taxIdr: grossSum - net, totalIdr: grossSum };
  }
  const taxIdr = Math.round((grossSum * tax.rateBps) / 10000);
  return { subtotalIdr: grossSum, taxIdr, totalIdr: grossSum + taxIdr };
}
