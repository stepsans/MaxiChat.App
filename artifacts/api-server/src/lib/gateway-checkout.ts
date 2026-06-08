import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  paymentsTable,
  invoicesTable,
  type PaymentKind,
} from "@workspace/db";
import { logger } from "./logger";
import {
  getActiveProvider,
  getPaymentMethodRow,
  isManualBankConfigured,
  isVerificationConfigured,
  manualPaymentCode,
} from "./manual-payment-config";
import { appendManualOrderRow } from "./manual-payment-sheet";
import { createXenditInvoice, isXenditConfigured } from "./xendit";

// Shared "charge an existing OPEN invoice through the active gateway" helper
// (Billing v2 — pay-invoice + proration). It mirrors the cart /checkout flow
// but charges a SINGLE invoice (kind="invoice"|"proration", refId=invoiceId,
// no cart line_items — the invoice already carries its own line items). The
// resulting paid webhook/poller settles through the SAME settlePaymentPaid
// chokepoint, whose invoice/proration branch marks the invoice paid + applies
// its deferred entitlement directive.
//
// Returns a discriminated outcome so the caller maps ok→checkout body and
// !ok→the HTTP status/body, without throwing for expected misconfig states.

export type InvoiceCheckout = {
  paymentId: number;
  mode: "xendit" | "manual";
  amountIdr: number;
  invoiceUrl?: string | null;
  externalId?: string | null;
  code?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountHolder?: string | null;
  manualInstructions?: string | null;
};

export type CheckoutOutcome =
  | { ok: true; checkout: InvoiceCheckout }
  | { ok: false; status: number; body: { error: string; code?: string } };

export async function startInvoiceGatewayCheckout(
  ownerUserId: number,
  invoice: typeof invoicesTable.$inferSelect,
  kind: PaymentKind,
  redirect: string | undefined
): Promise<CheckoutOutcome> {
  const amountIdr = invoice.totalIdr;
  if (!Number.isInteger(amountIdr) || amountIdr <= 0) {
    return {
      ok: false,
      status: 400,
      body: { error: "Nominal invoice tidak valid", code: "invalid_amount" },
    };
  }

  const provider = await getActiveProvider();
  const description = `Pembayaran Invoice ${invoice.invoiceNumber}`;

  const [owner] = await db
    .select({ email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);

  // --- Manual bank-transfer ----------------------------------------------
  if (provider === "manual") {
    const methodRow = await getPaymentMethodRow();
    if (!isManualBankConfigured(methodRow)) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "Pembayaran manual belum dikonfigurasi. Hubungi admin.",
          code: "manual_unconfigured",
        },
      };
    }
    if (!isVerificationConfigured(methodRow)) {
      return {
        ok: false,
        status: 503,
        body: {
          error:
            "Sheet verifikasi pembayaran belum dikonfigurasi. Hubungi admin.",
          code: "verification_unconfigured",
        },
      };
    }

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: ownerUserId,
        kind,
        refId: invoice.id,
        quantity: 1,
        amountIdr,
        status: "pending",
        provider: "manual",
        externalId: null,
      })
      .returning();

    const code = manualPaymentCode(payment.id);
    await db
      .update(paymentsTable)
      .set({ externalId: code, updatedAt: new Date() })
      .where(eq(paymentsTable.id, payment.id));

    try {
      await appendManualOrderRow(
        {
          paymentId: payment.id,
          tenantName: owner?.name ?? owner?.email ?? `User #${ownerUserId}`,
          email: owner?.email ?? "",
          item: description,
          amountIdr,
        },
        methodRow
      );
    } catch (err) {
      await db
        .update(paymentsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(paymentsTable.id, payment.id));
      logger.error(
        { err, paymentId: payment.id },
        "manual invoice order row append failed"
      );
      return {
        ok: false,
        status: 502,
        body: {
          error: "Gagal mencatat pesanan. Coba lagi atau hubungi admin.",
          code: "sheet_append_failed",
        },
      };
    }

    return {
      ok: true,
      checkout: {
        paymentId: payment.id,
        mode: "manual",
        amountIdr,
        code,
        externalId: code,
        bankName: methodRow.bankName,
        bankAccountNumber: methodRow.bankAccountNumber,
        bankAccountHolder: methodRow.bankAccountHolder,
        manualInstructions: methodRow.manualInstructions,
      },
    };
  }

  // --- Xendit hosted invoice ---------------------------------------------
  if (!(await isXenditConfigured())) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "Payment gateway belum dikonfigurasi. Hubungi admin.",
        code: "gateway_unconfigured",
      },
    };
  }

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      userId: ownerUserId,
      kind,
      refId: invoice.id,
      quantity: 1,
      amountIdr,
      status: "pending",
      provider: "xendit",
    })
    .returning();

  let xendit;
  try {
    xendit = await createXenditInvoice({
      externalId: `maxichat-pay-${payment.id}`,
      amount: amountIdr,
      description,
      payerEmail: owner?.email,
      successRedirectUrl: redirect,
      failureRedirectUrl: redirect,
    });
  } catch (err) {
    await db
      .update(paymentsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(paymentsTable.id, payment.id));
    logger.error(
      { err, paymentId: payment.id },
      "xendit invoice (pay-invoice) failed"
    );
    return {
      ok: false,
      status: 502,
      body: { error: "Gagal membuat invoice pembayaran" },
    };
  }

  await db
    .update(paymentsTable)
    .set({
      externalId: xendit.id,
      invoiceUrl: xendit.invoiceUrl,
      updatedAt: new Date(),
    })
    .where(eq(paymentsTable.id, payment.id));

  return {
    ok: true,
    checkout: {
      paymentId: payment.id,
      mode: "xendit",
      amountIdr,
      invoiceUrl: xendit.invoiceUrl,
      externalId: xendit.id,
    },
  };
}
