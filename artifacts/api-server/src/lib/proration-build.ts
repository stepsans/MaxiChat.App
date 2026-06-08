// Pure, db-free proration math (Billing v2 — FASE D). Kept free of any
// @workspace/db import so it stays unit-testable under the node:test runner.
//
// When a tenant changes plan or quota mid-period we charge/credit only the
// UNUSED remainder of the period. Upgrade → charge the prorated difference now;
// downgrade/remove → credit the prorated difference to the wallet (never a cash
// refund). All money is whole Rupiah.
import type { InvoiceLineInput } from "./invoice-build";

// Fraction of the current period still REMAINING at `now`, in [0, 1]. Based on
// whole-ms span (anniversary-aligned periods come from computeBillingPeriod).
// Clamped: before start → 1 (whole period ahead), after end → 0.
export function prorationFactor(
  now: Date,
  periodStart: Date,
  periodEnd: Date
): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return 0;
  const remaining = periodEnd.getTime() - now.getTime();
  if (remaining <= 0) return 0;
  if (remaining >= total) return 1;
  return remaining / total;
}

export type ProrationLines = {
  lines: InvoiceLineInput[];
  // Net amount: > 0 → charge the tenant now; < 0 → credit to wallet; 0 → no-op.
  netIdr: number;
  factor: number;
};

// Build proration lines for swapping one priced component for another mid-
// period. `oldPriceIdr` is the full-period price of what the tenant currently
// has (credited back prorated); `newPriceIdr` the full-period price of what
// they're moving to (charged prorated). For pure additions oldPrice=0; for pure
// removals newPrice=0.
//
//   credit = round(oldPrice × factor)   → proration_credit line (negative)
//   charge = round(newPrice × factor)   → proration_charge line (positive)
//   net    = charge − credit
export function buildProrationLines(
  oldPriceIdr: number,
  newPriceIdr: number,
  oldLabel: string,
  newLabel: string,
  now: Date,
  periodStart: Date,
  periodEnd: Date
): ProrationLines {
  const factor = prorationFactor(now, periodStart, periodEnd);
  const credit = Math.round(Math.max(0, oldPriceIdr) * factor);
  const charge = Math.round(Math.max(0, newPriceIdr) * factor);
  const lines: InvoiceLineInput[] = [];

  if (credit > 0) {
    lines.push({
      lineType: "proration_credit",
      refId: null,
      description: `Kredit prorata: ${oldLabel}`,
      quantity: 1,
      unitPriceIdr: -credit,
      amountIdr: -credit,
    });
  }
  if (charge > 0) {
    lines.push({
      lineType: "proration_charge",
      refId: null,
      description: `Biaya prorata: ${newLabel}`,
      quantity: 1,
      unitPriceIdr: charge,
      amountIdr: charge,
    });
  }

  return { lines, netIdr: charge - credit, factor };
}
