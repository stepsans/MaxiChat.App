import { eq } from "drizzle-orm";
import {
  db,
  paymentsTable,
  invoicesTable,
  type PaymentKind,
  type PaymentLineItem,
} from "@workspace/db";
import { markInvoicePaid, clearDunningForOwner } from "./dunning";
import { applyPaidPayment, applyInvoiceDirective } from "./subscription-purchase";
import { debitWallet } from "./wallet";
import { createInvoiceForPayment } from "./invoices";

// Settle an OPEN invoice ENTIRELY from the tenant's wallet credit (Billing v2 —
// Credit/Wallet + FASE F). Only used when the wallet fully covers the invoice
// total (we never partially pay an invoice — partial wallet use happens on the
// cart-checkout fast path instead). The whole thing is one transaction:
//
//   markInvoicePaid (status guard = idempotency) → debit wallet → insert a paid
//   payment (provider="wallet") → link it to the invoice → apply the deferred
//   entitlement directive → clear dunning.
//
// markInvoicePaid runs FIRST so a double-submit can't double-debit: the second
// call finds the invoice already paid (null) and aborts before touching the
// wallet. Returns the new payment id, or null when the invoice was not open.
export async function settleInvoiceByWallet(
  ownerId: number,
  invoiceId: number,
  amountIdr: number,
  kind: PaymentKind
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const invoice = await markInvoicePaid(invoiceId, tx);
    if (!invoice) return null;
    // Defense-in-depth: the route already owner-scopes via getInvoiceForOwner,
    // but never debit one tenant's wallet for another tenant's invoice even if
    // this helper is reused/miscalled. Throwing rolls back the paid-flip.
    if (invoice.userId !== ownerId) {
      throw new Error("invoice does not belong to the given owner");
    }

    const debited = await debitWallet(
      ownerId,
      amountIdr,
      `invoice:${invoiceId}`,
      tx
    );
    if (debited < amountIdr) {
      // Caller must verify full coverage before calling; if the balance shifted
      // under us, roll back so we never half-pay an invoice from the wallet.
      throw new Error("wallet balance does not fully cover the invoice");
    }

    const [payment] = await tx
      .insert(paymentsTable)
      .values({
        userId: ownerId,
        kind,
        refId: invoiceId,
        quantity: 1,
        amountIdr,
        status: "paid",
        paidAt: new Date(),
        provider: "wallet",
        externalId: `maxichat-wallet-inv-${invoiceId}`,
      })
      .returning();

    await tx
      .update(invoicesTable)
      .set({ paymentId: payment.id })
      .where(eq(invoicesTable.id, invoice.id));

    await applyInvoiceDirective(invoice, tx);
    await clearDunningForOwner(ownerId, tx);
    return payment.id;
  });
}

// Settle a cart ENTIRELY from the tenant's wallet credit (Billing v2 — wallet-
// first checkout fast path). Only used when the wallet fully covers the cart
// total. One transaction: insert a paid cart payment (provider="wallet") → debit
// the wallet → grant entitlements (plans before add-ons via applyPaidPayment's
// cart branch) → raise the immutable invoice. Returns the new payment id. Throws
// (rolls back) if the balance shifted under us so we never half-pay a cart.
export async function settleCartByWallet(
  ownerId: number,
  amountIdr: number,
  lineItems: PaymentLineItem[]
): Promise<number> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .insert(paymentsTable)
      .values({
        userId: ownerId,
        kind: "cart",
        refId: null,
        quantity: 1,
        amountIdr,
        lineItems,
        status: "paid",
        paidAt: new Date(),
        provider: "wallet",
      })
      .returning();

    await tx
      .update(paymentsTable)
      .set({ externalId: `maxichat-wallet-pay-${payment.id}` })
      .where(eq(paymentsTable.id, payment.id));

    const debited = await debitWallet(
      ownerId,
      amountIdr,
      `cart:${payment.id}`,
      tx
    );
    if (debited < amountIdr) {
      throw new Error("wallet balance does not fully cover the cart");
    }

    await applyPaidPayment({ ...payment, externalId: `maxichat-wallet-pay-${payment.id}` }, tx);
    await createInvoiceForPayment(
      { ...payment, externalId: `maxichat-wallet-pay-${payment.id}` },
      tx
    );
    return payment.id;
  });
}
