import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import type { InvoiceLineInput } from "./invoice-build";
import { computeInvoiceTotals } from "./invoice-build";
import { getTaxConfig } from "./tax-config";
import {
  encodeInvoiceDirective,
  type InvoiceDirective,
} from "./proration-directive";

// DB layer for mid-period plan/quota changes (Billing v2 — FASE D). A change
// that COSTS money raises an `open` proration invoice whose entitlement
// directive (encoded in `notes`) is applied ONLY once the charge is collected
// — the same deferred-grant pattern the dunning/pay-invoice path already uses.
// The pure proration math lives in db-free `proration-build.ts`.

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;

// Days a proration charge invoice stays open before the dunning sweep escalates.
export const PRORATION_TERM_DAYS = 7;

// Create an OPEN proration invoice (source="proration", paymentId null) carrying
// the entitlement directive in `notes`, plus its line items. Totals honor the
// operator's tax policy (like monthly_close) so the collected amount == total.
// Returns the new invoice id + total to charge. Run inside a transaction by
// passing `exec`.
export async function createOpenProrationInvoice(
  ownerId: number,
  lines: InvoiceLineInput[],
  directive: InvoiceDirective,
  exec: DbExecutor = db
): Promise<{ id: number; totalIdr: number }> {
  const now = new Date();
  const taxConfig = await getTaxConfig(exec);
  const { subtotalIdr, taxIdr, totalIdr } = computeInvoiceTotals(
    lines,
    taxConfig
  );

  // Two-step: insert with a temporary unique number, then rewrite it to the
  // proration series using the row id (the number must be unique + notNull).
  const [inserted] = await exec
    .insert(invoicesTable)
    .values({
      userId: ownerId,
      invoiceNumber: `PENDING-${randomUUID()}`,
      source: "proration",
      paymentId: null,
      status: "open",
      currency: "IDR",
      subtotalIdr,
      taxIdr,
      totalIdr,
      issuedAt: now,
      dueAt: new Date(now.getTime() + PRORATION_TERM_DAYS * DAY_MS),
      notes: encodeInvoiceDirective(directive),
    })
    .returning({ id: invoicesTable.id });

  const id = inserted.id;
  const invoiceNumber = `INV-PRO-${now.getUTCFullYear()}-${String(id).padStart(
    6,
    "0"
  )}`;
  await exec
    .update(invoicesTable)
    .set({ invoiceNumber })
    .where(eq(invoicesTable.id, id));

  if (lines.length > 0) {
    await exec.insert(invoiceLineItemsTable).values(
      lines.map((l) => ({
        invoiceId: id,
        lineType: l.lineType,
        refId: l.refId,
        description: l.description,
        quantity: l.quantity,
        unitPriceIdr: l.unitPriceIdr,
        amountIdr: l.amountIdr,
      }))
    );
  }

  return { id, totalIdr };
}
