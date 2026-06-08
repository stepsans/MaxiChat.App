import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
  paymentsTable,
  type PaymentRow,
} from "@workspace/db";
import { logger } from "./logger";
import {
  invoiceNumberForPayment,
  invoiceLinesFromPayment,
  computeInvoiceTotals,
} from "./invoice-build";
import { getTaxConfig } from "./tax-config";

// A db handle that may be the root connection OR an open transaction, so
// invoice creation can run inside the settlement transaction (atomic with the
// pending→paid flip + entitlement grant).
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Create the immutable invoice for a SETTLED payment. Idempotent: the unique
// index on payment_id makes a second call a no-op (returns null). Prices come
// from the payment's snapshot, so a later catalog change never alters it.
//
// Pass an open transaction (`exec`) to make invoice creation atomic with
// settlement; called bare it runs in its own implicit transaction (backfill).
export async function createInvoiceForPayment(
  payment: PaymentRow,
  exec: DbExecutor = db
): Promise<number | null> {
  // Only paid payments are revenue. Guard so a stray call on a pending/failed
  // row can never raise a phantom invoice.
  if (payment.status !== "paid") return null;

  const issuedAt = payment.paidAt ?? payment.createdAt ?? new Date();
  const invoiceNumber = invoiceNumberForPayment(payment.id, issuedAt);
  const lines = invoiceLinesFromPayment(payment);
  // Tax (FASE G): the amount was ALREADY collected, so it is the gross total —
  // force INCLUSIVE decomposition so the invoice total stays == amountIdr (the
  // financial-consistency guard below still holds). When tax is disabled this is
  // a no-op (tax 0). Read via `exec` so it's consistent with the settlement tx.
  const taxConfig = await getTaxConfig(exec);
  const { subtotalIdr, taxIdr, totalIdr } = computeInvoiceTotals(lines, {
    ...taxConfig,
    inclusive: true,
  });

  // Financial-consistency guard: the snapshot is the source of truth, so we
  // still issue the invoice, but a divergence from the paid ledger amount means
  // a corrupt/legacy line_items snapshot — surface it for reconciliation rather
  // than letting revenue silently drift.
  if (totalIdr !== payment.amountIdr) {
    logger.warn(
      {
        paymentId: payment.id,
        ownerId: payment.userId,
        invoiceTotalIdr: totalIdr,
        paymentAmountIdr: payment.amountIdr,
      },
      "invoice total does not match payment amount (snapshot mismatch)"
    );
  }

  const inserted = await exec
    .insert(invoicesTable)
    .values({
      userId: payment.userId,
      invoiceNumber,
      source: "payment",
      paymentId: payment.id,
      status: "paid",
      currency: "IDR",
      subtotalIdr,
      taxIdr,
      totalIdr,
      issuedAt,
      paidAt: payment.paidAt ?? issuedAt,
    })
    .onConflictDoNothing({ target: invoicesTable.paymentId })
    .returning({ id: invoicesTable.id });

  // Already invoiced (concurrent settlement / re-run): nothing more to do.
  if (inserted.length === 0) return null;

  const invoiceId = inserted[0].id;
  if (lines.length > 0) {
    await exec.insert(invoiceLineItemsTable).values(
      lines.map((l) => ({
        invoiceId,
        lineType: l.lineType,
        refId: l.refId,
        description: l.description,
        quantity: l.quantity,
        unitPriceIdr: l.unitPriceIdr,
        amountIdr: l.amountIdr,
      }))
    );
  }
  return invoiceId;
}

// One-time, idempotent backfill: raise an invoice for every already-paid
// payment that doesn't have one yet. Cheap to re-run (the NOT EXISTS filter
// returns 0 rows once caught up). Each payment is invoiced in its own
// transaction so the invoice + its line items are all-or-nothing.
export async function backfillInvoicesFromPayments(): Promise<number> {
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.status, "paid"),
        sql`NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = ${paymentsTable.id})`
      )
    );

  let created = 0;
  for (const payment of rows) {
    try {
      const id = await db.transaction((tx) =>
        createInvoiceForPayment(payment as PaymentRow, tx)
      );
      if (id != null) created++;
    } catch (err) {
      logger.error(
        { err, paymentId: payment.id },
        "backfillInvoicesFromPayments: failed for one payment"
      );
    }
  }
  return created;
}

// List a tenant owner's invoices, newest first.
export async function listInvoicesForOwner(
  ownerUserId: number
): Promise<(typeof invoicesTable.$inferSelect)[]> {
  return db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.userId, ownerUserId))
    .orderBy(desc(invoicesTable.issuedAt), desc(invoicesTable.id));
}

// The immutable invoice snapshot raised from a settled payment, owner-scoped.
// Returns null for payments with no invoice yet (e.g. still-pending rows) or a
// foreign owner. Used by the PDF endpoint to render the FROZEN tax breakdown
// (subtotal/tax snapshotted at issue) instead of recomputing from live config.
export async function getInvoiceByPaymentId(
  ownerUserId: number,
  paymentId: number
): Promise<typeof invoicesTable.$inferSelect | null> {
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.paymentId, paymentId),
        eq(invoicesTable.userId, ownerUserId)
      )
    )
    .limit(1);
  return invoice ?? null;
}

// One owner-scoped invoice with its line items, or null if not found / foreign.
export async function getInvoiceForOwner(
  ownerUserId: number,
  invoiceId: number
): Promise<{
  invoice: typeof invoicesTable.$inferSelect;
  lineItems: (typeof invoiceLineItemsTable.$inferSelect)[];
} | null> {
  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.userId, ownerUserId))
    )
    .limit(1);
  if (!invoice) return null;

  const lineItems = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(invoiceLineItemsTable.id);

  return { invoice, lineItems };
}
