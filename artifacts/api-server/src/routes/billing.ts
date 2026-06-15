import { Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  plansTable,
  addonsTable,
  paymentsTable,
  tenantQuotaTable,
  type PaymentLineItem,
} from "@workspace/db";
import {
  CreateCheckoutBody,
  PayMyInvoiceBody,
  ChangeMyPlanBody,
  ChangeMyQuotaBody,
} from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  computeOwnerBill,
  computeOwnerUsage,
  getEffectiveSubscription,
  computeOwnerTrend,
} from "../lib/billing";
import {
  isInfinityOwner,
  INFINITY_PLAN_LABEL,
  INFINITY_PLAN_KEY,
} from "../lib/infinity-owner";
import {
  getOrCreateTenantQuota,
  applyPlanProration,
  addAddonToQuota,
} from "../lib/subscription-purchase";
import {
  getWalletBalance,
  listWalletTransactions,
  recordWalletTransaction,
} from "../lib/wallet";
import {
  getCreditWalletSummary,
  listCreditUsage,
  listCreditLedger,
} from "../lib/credit-wallet";
import { getPlatformAiConfig } from "../lib/platform-ai-config";
import { settleInvoiceByWallet, settleCartByWallet } from "../lib/pay-invoice";
import { startInvoiceGatewayCheckout } from "../lib/gateway-checkout";
import { createOpenProrationInvoice } from "../lib/proration";
import { buildProrationLines } from "../lib/proration-build";
import { decodeInvoiceDirective } from "../lib/proration-directive";
import { getStorageConfig } from "../lib/storage-config";
import {
  listInvoicesForOwner,
  getInvoiceForOwner,
  getInvoiceByPaymentId,
} from "../lib/invoices";
import {
  createXenditInvoice,
  isXenditConfigured,
} from "../lib/xendit";
import {
  getPaymentMethodRow,
  getActiveProvider,
  isManualBankConfigured,
  isVerificationConfigured,
  manualPaymentCode,
} from "../lib/manual-payment-config";
import { appendManualOrderRow } from "../lib/manual-payment-sheet";
import { buildInvoicePdf, type InvoiceBank } from "../lib/invoice-pdf";
import {
  computeInvoiceTotals,
  invoiceLinesFromPayment,
} from "../lib/invoice-build";
import { getTaxConfig } from "../lib/tax-config";

const router = Router();

// Build the post-payment redirect URL. We only honour a client-supplied URL
// when its host is one of our published app domains (REPLIT_DOMAINS) or the dev
// domain — this prevents an open-redirect via the invoice page. Falls back to
// the first app domain root, or undefined if none is known.
function resolveRedirectUrl(candidate: unknown): string | undefined {
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const devDomain = process.env.REPLIT_DEV_DOMAIN?.trim();
  const allowed = new Set([...domains, ...(devDomain ? [devDomain] : [])]);

  if (typeof candidate === "string" && candidate.length > 0) {
    try {
      const u = new URL(candidate);
      if (u.protocol === "https:" && allowed.has(u.host)) return u.toString();
    } catch {
      // fall through to default
    }
  }
  const fallback = domains[0] ?? devDomain;
  return fallback ? `https://${fallback}/` : undefined;
}

// GET /billing/me — the signed-in tenant owner's subscription, live usage and
// computed monthly bill. Team members (supervisor/agent) resolve to their
// owner, so the figures shown are always the OWNER's tenant-wide spend.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    // Guard against a stale session whose owner was deleted: without this the
    // FK insert in getOrCreateSubscription would throw a 500. Return 404 so the
    // client can treat it as a logged-out / gone account deterministically.
    const ownerExists = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM users WHERE id = ${ownerUserId}) AS exists
    `);
    const exists =
      (ownerExists as any).rows?.[0]?.exists ??
      (ownerExists as any)[0]?.exists ??
      false;
    if (!exists) {
      res.status(404).json({ error: "Tenant owner not found" });
      return;
    }

    const [subscription, bill, unlimited] = await Promise.all([
      getEffectiveSubscription(ownerUserId),
      computeOwnerBill(ownerUserId),
      isInfinityOwner(ownerUserId),
    ]);

    res.json({
      subscription,
      usage: bill.usage,
      pricing: bill.pricing,
      breakdown: bill.breakdown,
      // Owner Infinity: the client renders the plan name and suppresses the
      // metered-charge breakdown / upsell. Usage is still reported as-is.
      unlimited,
      planLabel: unlimited ? INFINITY_PLAN_LABEL : null,
    });
  } catch (err) {
    req.log.error({ err }, "getMyBilling failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/trend — the signed-in tenant's daily spend trend (oldest-first).
// Team members resolve to their owner. `days` clamps the window length.
router.get("/trend", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const rawDays = Number(req.query.days);
    const days =
      Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365
        ? Math.floor(rawDays)
        : 30;

    const trend = await computeOwnerTrend(ownerUserId, days);
    res.json({ trend });
  } catch (err) {
    req.log.error({ err }, "getMyBillingTrend failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/catalog — active plans + add-ons the tenant can purchase. Open to
// any signed-in user (the FASE 5 UI renders checkout options from this).
router.get("/catalog", async (req, res): Promise<void> => {
  try {
    const [plans, addons] = await Promise.all([
      db
        .select()
        .from(plansTable)
        .where(eq(plansTable.isActive, true))
        .orderBy(asc(plansTable.sortOrder), asc(plansTable.id)),
      db
        .select()
        .from(addonsTable)
        .where(eq(addonsTable.isActive, true))
        .orderBy(asc(addonsTable.sortOrder), asc(addonsTable.id)),
    ]);
    res.json({ plans, addons });
  } catch (err) {
    req.log.error({ err }, "getBillingCatalog failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/payment-method — tells the tenant checkout UI whether payments
// go through Xendit (invoice redirect) or a manual bank transfer, and in the
// manual case exposes the operator's bank account to display. No secrets.
router.get("/payment-method", async (req, res): Promise<void> => {
  try {
    const row = await getPaymentMethodRow();
    if (row.activeProvider === "manual") {
      res.json({
        activeProvider: "manual",
        bankName: row.bankName,
        bankAccountNumber: row.bankAccountNumber,
        bankAccountHolder: row.bankAccountHolder,
        manualInstructions: row.manualInstructions,
      });
      return;
    }
    res.json({
      activeProvider: "xendit",
      bankName: null,
      bankAccountNumber: null,
      bankAccountHolder: null,
      manualInstructions: null,
    });
  } catch (err) {
    req.log.error({ err }, "getBillingPaymentMethod failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/quota — the tenant's current prepaid limits (plafon) + live
// usage. Limits come from tenant_quota (plan baseline + add-on top-ups); usage
// is computed live so it never drifts.
router.get("/quota", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const quota = await getOrCreateTenantQuota(ownerUserId);
    if (!quota) {
      res.status(404).json({ error: "Tenant owner not found" });
      return;
    }

    const unlimited = await isInfinityOwner(ownerUserId);

    let planKey: string | null = null;
    let planName: string | null = null;
    if (unlimited) {
      // Owner Infinity isn't a real catalog plan; surface a synthetic label so
      // the dashboard renders "Owner Infinity" and ∞ quotas.
      planKey = INFINITY_PLAN_KEY;
      planName = INFINITY_PLAN_LABEL;
    } else if (quota.planId != null) {
      const [plan] = await db
        .select({ key: plansTable.key, name: plansTable.name })
        .from(plansTable)
        .where(eq(plansTable.id, quota.planId))
        .limit(1);
      planKey = plan?.key ?? null;
      planName = plan?.name ?? null;
    }

    const usage = await computeOwnerUsage(ownerUserId);

    // FASE C: surface the storage policy so the dashboard can render an accurate
    // near-limit warning (and phrase it as a hard block vs a soft heads-up).
    const storageConfig = await getStorageConfig();

    res.json({
      planId: quota.planId,
      planKey,
      planName,
      tokenLimit: quota.tokenLimit,
      channelLimit: quota.channelLimit,
      userLimit: quota.userLimit,
      storageLimit: quota.storageLimit,
      periodStart: quota.periodStart,
      periodEnd: quota.periodEnd,
      usage,
      // True only for the Owner Infinity account; the client renders ∞ and
      // skips progress bars / near-limit warnings.
      unlimited,
      storageEnforcementEnabled: storageConfig.enforcementEnabled,
      storageWarnPercent: storageConfig.warnPercent,
    });
  } catch (err) {
    req.log.error({ err }, "getMyQuota failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /billing/checkout — start a Xendit hosted-invoice checkout for a plan or
// add-on. The amount is computed server-side from the catalog (the client never
// sends a price). A pending payment row is inserted first so the webhook has a
// row to reconcile; the Xendit invoice id is then stored as externalId.
//
// This lives under /billing, which enforceSubscription exempts — so an EXPIRED
// tenant can still reach it to renew.
router.post("/checkout", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = CreateCheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const items = parsed.data.items;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Keranjang kosong" });
      return;
    }

    // A cart may contain at most ONE plan (always quantity 1). OpenAPI `integer`
    // codegens to zod.number() (accepts decimals), so re-check Number.isInteger
    // on refId + quantity — money must stay whole-Rupiah.
    const planCount = items.filter((it) => it.kind === "plan").length;
    if (planCount > 1) {
      res.status(400).json({
        error: "Hanya boleh memilih 1 paket dalam satu keranjang.",
        code: "too_many_plans",
      });
      return;
    }
    for (const it of items) {
      if (!Number.isInteger(it.refId) || it.refId < 1) {
        res.status(400).json({ error: "refId tidak valid" });
        return;
      }
      const qty = it.kind === "addon" ? it.quantity ?? 1 : 1;
      if (!Number.isInteger(qty) || qty < 1) {
        res.status(400).json({ error: "Jumlah harus bilangan bulat ≥ 1" });
        return;
      }
    }

    const provider = await getActiveProvider();

    const ownerUserId = await resolveOwnerUserId(userId);

    // Resolve each catalog item, snapshot its price + compute the cart total
    // server-side (the client never sends a price).
    const lineItems: PaymentLineItem[] = [];
    for (const it of items) {
      if (it.kind === "plan") {
        const [plan] = await db
          .select()
          .from(plansTable)
          .where(and(eq(plansTable.id, it.refId), eq(plansTable.isActive, true)))
          .limit(1);
        if (!plan) {
          res
            .status(404)
            .json({ error: "Paket tidak ditemukan / tidak aktif" });
          return;
        }
        lineItems.push({
          kind: "plan",
          refId: plan.id,
          quantity: 1,
          name: `Paket ${plan.name}`,
          unitPriceIdr: plan.priceIdr,
          lineAmountIdr: plan.priceIdr,
        });
      } else {
        const qty = it.quantity ?? 1;
        const [addon] = await db
          .select()
          .from(addonsTable)
          .where(
            and(eq(addonsTable.id, it.refId), eq(addonsTable.isActive, true))
          )
          .limit(1);
        if (!addon) {
          res
            .status(404)
            .json({ error: "Add-on tidak ditemukan / tidak aktif" });
          return;
        }
        lineItems.push({
          kind: "addon",
          refId: addon.id,
          quantity: qty,
          name: `Add-on ${addon.name}`,
          unitPriceIdr: addon.priceIdr,
          lineAmountIdr: addon.priceIdr * qty,
        });
      }
    }

    const amountIdr = lineItems.reduce((sum, li) => sum + li.lineAmountIdr, 0);
    const description =
      lineItems.length === 1
        ? `${lineItems[0].name}${
            lineItems[0].quantity > 1 ? ` x${lineItems[0].quantity}` : ""
          }`
        : `Pembelian ${lineItems.length} item MaxiChat`;

    if (amountIdr <= 0) {
      res.status(400).json({
        error: "Harga item ini belum diatur. Hubungi admin.",
        code: "zero_price",
      });
      return;
    }

    // Owner email + name identify the payer (invoice receipt / Sheet row).
    const [owner] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);

    // --- Wallet-first fast path -------------------------------------------
    // If the tenant's credit fully covers the cart, settle it straight from the
    // wallet — no gateway / manual transfer needed. We never PARTIALLY pay a
    // cart from the wallet (mixing credit + gateway in one order); partial
    // credit is consumed only on metered/usage paths. Infinity owners are never
    // billed, so they never reach checkout with a balance to spend here.
    const walletBalance = await getWalletBalance(ownerUserId);
    if (walletBalance >= amountIdr && amountIdr > 0) {
      try {
        const paidId = await settleCartByWallet(ownerUserId, amountIdr, lineItems);
        res.json({ paymentId: paidId, mode: "wallet", amountIdr });
        return;
      } catch (err) {
        // Balance shifted under us (concurrent debit) — fall through to the
        // configured gateway/manual path rather than failing the checkout.
        req.log.warn({ err, ownerUserId }, "wallet-first checkout fell through");
      }
    }

    // --- Manual bank-transfer checkout ------------------------------------
    // The operator collects payment off-platform and confirms it by flipping
    // the order's Status cell to LUNAS in their verification Sheet; a poller
    // then settles it. We write a PENDING order row here and return the bank
    // details + payment code for the customer to reference on transfer.
    if (provider === "manual") {
      const methodRow = await getPaymentMethodRow();
      // Manual mode is "Otomatis": every order MUST land in the verification
      // Sheet, because flipping its Status cell to LUNAS is the only path that
      // settles the payment. Without bank details the customer can't pay, and
      // without a configured Sheet there is no settlement path — so require
      // both up front rather than creating an orphan pending payment.
      if (!isManualBankConfigured(methodRow)) {
        res.status(503).json({
          error: "Pembayaran manual belum dikonfigurasi. Hubungi admin.",
          code: "manual_unconfigured",
        });
        return;
      }
      if (!isVerificationConfigured(methodRow)) {
        res.status(503).json({
          error:
            "Sheet verifikasi pembayaran belum dikonfigurasi. Hubungi admin.",
          code: "verification_unconfigured",
        });
        return;
      }

      const [payment] = await db
        .insert(paymentsTable)
        .values({
          userId: ownerUserId,
          kind: "cart",
          refId: null,
          quantity: 1,
          amountIdr,
          lineItems,
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

      // The Sheet row is mandatory (it's the settlement surface). If the append
      // fails, fail the order fast and mark the pending row `failed` so it isn't
      // left dangling and the customer can retry, rather than transferring money
      // against an order the operator will never see.
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
        req.log.error(
          { err, paymentId: payment.id },
          "manual order row append failed"
        );
        res.status(502).json({
          error: "Gagal mencatat pesanan. Coba lagi atau hubungi admin.",
          code: "sheet_append_failed",
        });
        return;
      }

      res.json({
        paymentId: payment.id,
        mode: "manual",
        amountIdr,
        code,
        externalId: code,
        bankName: methodRow.bankName,
        bankAccountNumber: methodRow.bankAccountNumber,
        bankAccountHolder: methodRow.bankAccountHolder,
        manualInstructions: methodRow.manualInstructions,
      });
      return;
    }

    // --- Xendit hosted-invoice checkout -----------------------------------
    if (!(await isXenditConfigured())) {
      res.status(503).json({
        error: "Payment gateway belum dikonfigurasi. Hubungi admin.",
        code: "gateway_unconfigured",
      });
      return;
    }

    // 1) Insert the pending payment so the webhook always has a row to find.
    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: ownerUserId,
        kind: "cart",
        refId: null,
        quantity: 1,
        amountIdr,
        lineItems,
        status: "pending",
        provider: "xendit",
      })
      .returning();

    // 2) Create the hosted invoice. Our reference embeds the payment id; Xendit
    //    echoes it back as external_id on the webhook (a fallback lookup).
    const redirect = resolveRedirectUrl(parsed.data.successRedirectUrl);
    let invoice;
    try {
      invoice = await createXenditInvoice({
        externalId: `maxichat-pay-${payment.id}`,
        amount: amountIdr,
        description,
        payerEmail: owner?.email,
        successRedirectUrl: redirect,
        failureRedirectUrl: redirect,
      });
    } catch (err) {
      // Mark the orphan payment failed so it isn't left dangling as pending.
      await db
        .update(paymentsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(paymentsTable.id, payment.id));
      req.log.error({ err, paymentId: payment.id }, "xendit invoice failed");
      res.status(502).json({ error: "Gagal membuat invoice pembayaran" });
      return;
    }

    // 3) Store the Xendit invoice id (externalId) + URL for reconciliation.
    await db
      .update(paymentsTable)
      .set({
        externalId: invoice.id,
        invoiceUrl: invoice.invoiceUrl,
        updatedAt: new Date(),
      })
      .where(eq(paymentsTable.id, payment.id));

    res.json({
      paymentId: payment.id,
      mode: "xendit",
      invoiceUrl: invoice.invoiceUrl,
      externalId: invoice.id,
      amountIdr,
    });
  } catch (err) {
    req.log.error({ err }, "createCheckout failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/payments — the tenant's purchase ledger, newest first.
router.get("/payments", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const rows = await db
      .select({
        id: paymentsTable.id,
        kind: paymentsTable.kind,
        refId: paymentsTable.refId,
        quantity: paymentsTable.quantity,
        amountIdr: paymentsTable.amountIdr,
        status: paymentsTable.status,
        provider: paymentsTable.provider,
        externalId: paymentsTable.externalId,
        invoiceUrl: paymentsTable.invoiceUrl,
        lineItems: paymentsTable.lineItems,
        paidAt: paymentsTable.paidAt,
        createdAt: paymentsTable.createdAt,
      })
      .from(paymentsTable)
      .where(eq(paymentsTable.userId, ownerUserId))
      .orderBy(desc(paymentsTable.createdAt));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "listMyPayments failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/invoices — the tenant's immutable invoices (newest first). These
// are the formal financial records (FASE A): prices are snapshotted at issue so
// a later catalog change never rewrites history. Owner-scoped.
router.get("/invoices", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    const invoices = await listInvoicesForOwner(ownerUserId);
    res.json(invoices);
  } catch (err) {
    req.log.error({ err }, "listMyInvoices failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/invoices/:id — one invoice with its line items. Owner-scoped: an
// invoice belonging to another tenant 404s (not 403) so ids aren't enumerable.
router.get("/invoices/:id", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1) {
      res.status(400).json({ error: "ID invoice tidak valid" });
      return;
    }

    const detail = await getInvoiceForOwner(ownerUserId, invoiceId);
    if (!detail) {
      res.status(404).json({ error: "Invoice tidak ditemukan" });
      return;
    }
    res.json(detail);
  } catch (err) {
    req.log.error({ err }, "getMyInvoice failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/payments/:id/invoice — a downloadable PDF invoice for one of the
// caller's payments. Owner-scoped (a payment belonging to another tenant 404s
// rather than 403, so ids aren't enumerable). Built on demand with pdf-lib.
router.get("/payments/:id/invoice", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const paymentId = Number(req.params.id);
    if (!Number.isInteger(paymentId) || paymentId < 1) {
      res.status(400).json({ error: "ID pembayaran tidak valid" });
      return;
    }

    const [payment] = await db
      .select()
      .from(paymentsTable)
      .where(
        and(
          eq(paymentsTable.id, paymentId),
          eq(paymentsTable.userId, ownerUserId)
        )
      )
      .limit(1);
    if (!payment) {
      res.status(404).json({ error: "Pembayaran tidak ditemukan" });
      return;
    }

    const [owner] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);

    // Manual transfer details are shown on a still-pending bank-transfer
    // invoice so the customer has the account to pay into. Bank fields are not
    // secret (returned to customers elsewhere too).
    let bank: InvoiceBank | null = null;
    if (payment.provider === "manual" && payment.status === "pending") {
      const methodRow = await getPaymentMethodRow();
      bank = {
        bankName: methodRow.bankName,
        bankAccountNumber: methodRow.bankAccountNumber,
        bankAccountHolder: methodRow.bankAccountHolder,
      };
    }

    // Tax breakdown (FASE G): the PDF must reproduce the IMMUTABLE invoice
    // snapshot, never recompute from live config — otherwise editing the tax
    // rate (or disabling tax) would silently rewrite historical PDFs and
    // diverge from the formal stored invoice. So for any settled payment with
    // an invoice we read the frozen subtotal/tax. Only pending rows (no invoice
    // yet — e.g. an unpaid manual transfer) fall back to a live preview, which
    // forces inclusive so the previewed total still equals the amount due.
    const invoice = await getInvoiceByPaymentId(ownerUserId, payment.id);
    const taxConfig = await getTaxConfig();
    let subtotalIdr: number;
    let taxIdr: number;
    if (invoice) {
      subtotalIdr = invoice.subtotalIdr;
      taxIdr = invoice.taxIdr;
    } else {
      const preview = computeInvoiceTotals(invoiceLinesFromPayment(payment), {
        ...taxConfig,
        inclusive: true,
      });
      subtotalIdr = preview.subtotalIdr;
      taxIdr = preview.taxIdr;
    }

    const pdf = await buildInvoicePdf({
      payment,
      lineItems: payment.lineItems ?? [],
      ownerName: owner?.name ?? "",
      ownerEmail: owner?.email ?? "",
      bank,
      subtotalIdr,
      taxIdr,
      taxLabel: taxConfig.label,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-INV-${payment.id}.pdf"`
    );
    res.send(Buffer.from(pdf));
  } catch (err) {
    req.log.error({ err }, "getPaymentInvoice failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/wallet — the tenant's credit balance + recent ledger (newest
// first). Balance is the live, non-expired total in whole Rupiah.
router.get("/wallet", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    const [balanceIdr, txns] = await Promise.all([
      getWalletBalance(ownerUserId),
      listWalletTransactions(ownerUserId, 50),
    ]);
    res.json({
      balanceIdr,
      transactions: txns.map((t) => ({
        id: t.id,
        deltaIdr: t.deltaIdr,
        kind: t.kind,
        sourceRef: t.sourceRef,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "getMyWallet failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/credit-wallet — the tenant's prepaid AI-CREDIT wallet (distinct
// from the Rupiah wallet above): two-bucket balances, runway, and banner level.
router.get("/credit-wallet", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    const cfg = await getPlatformAiConfig();
    const s = await getCreditWalletSummary(ownerUserId, cfg.minStopCredits);
    res.json({
      grantBalance: s.grantBalance,
      grantExpiresAt: s.grantExpiresAt,
      paidBalance: s.paidBalance,
      paidExpiresAt: s.paidExpiresAt,
      reserved: s.reserved,
      total: s.total,
      available: s.available,
      spentLast30d: s.spentLast30d,
      estDaysLeft: s.estDaysLeft,
      percentRemaining: s.percentRemaining,
      notice: s.notice,
    });
  } catch (err) {
    req.log.error({ err }, "getMyCreditWallet failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/credit-wallet/usage — recent AI usage charged to the wallet.
router.get("/credit-wallet/usage", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365 ? Math.floor(rawDays) : 30;
    const rows = await listCreditUsage(ownerUserId, days);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "getMyCreditWalletUsage failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /billing/credit-wallet/ledger — recent credit-wallet ledger entries.
router.get("/credit-wallet/ledger", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);
    const rows = await listCreditLedger(ownerUserId, 100);
    res.json(
      rows.map((r) => ({
        id: r.id,
        delta: r.delta,
        bucket: r.bucket,
        reason: r.reason,
        engine: r.engine,
        balanceAfter: r.balanceAfter,
        createdAt: r.createdAt,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "getMyCreditWalletLedger failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /billing/invoices/:id/pay — settle one OPEN invoice. Wallet credit is
// applied FIRST: if it fully covers the total the payment settles immediately
// (mode="wallet"); otherwise a gateway/manual checkout for the FULL amount is
// started (we never partial-pay an invoice from the wallet). The invoice's
// deferred entitlement directive (if any) is applied on settlement.
router.post("/invoices/:id/pay", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1) {
      res.status(400).json({ error: "ID invoice tidak valid" });
      return;
    }
    const parsed = PayMyInvoiceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }

    const detail = await getInvoiceForOwner(ownerUserId, invoiceId);
    if (!detail) {
      res.status(404).json({ error: "Invoice tidak ditemukan" });
      return;
    }
    const invoice = detail.invoice;
    if (invoice.status !== "open") {
      res
        .status(409)
        .json({ error: "Invoice ini sudah dibayar atau dibatalkan" });
      return;
    }

    const amountIdr = invoice.totalIdr;
    // A proration invoice carries an entitlement directive; a plain bill does
    // not. The payment kind drives the settlement branch either way.
    const kind = decodeInvoiceDirective(invoice.notes) ? "proration" : "invoice";

    // Wallet-first, full-cover only.
    const balance = await getWalletBalance(ownerUserId);
    if (balance >= amountIdr && amountIdr > 0) {
      const paymentId = await settleInvoiceByWallet(
        ownerUserId,
        invoiceId,
        amountIdr,
        kind
      );
      if (paymentId === null) {
        // Lost the race — another path settled it first.
        res
          .status(409)
          .json({ error: "Invoice ini sudah dibayar atau dibatalkan" });
        return;
      }
      res.json({ paymentId, mode: "wallet", amountIdr });
      return;
    }

    const redirect = resolveRedirectUrl(parsed.data.successRedirectUrl);
    const outcome = await startInvoiceGatewayCheckout(
      ownerUserId,
      invoice,
      kind,
      redirect
    );
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    res.json(outcome.checkout);
  } catch (err) {
    req.log.error({ err }, "payMyInvoice failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /billing/change-plan — switch plan mid-period with proration. Downgrade
// (net ≤ 0) applies immediately and credits the prorated difference to the
// wallet; upgrade (net > 0) raises a prorated OPEN invoice and tries wallet-
// first, else returns a checkout to pay. The plan change only takes effect once
// the charge is paid (deferred via the invoice directive).
router.post("/change-plan", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    if (await isInfinityOwner(ownerUserId)) {
      res.status(400).json({ error: "Akun ini tidak ditagih." });
      return;
    }

    const parsed = ChangeMyPlanBody.safeParse(req.body);
    if (!parsed.success || !Number.isInteger(parsed.data.planId)) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const { planId } = parsed.data;

    const [newPlan] = await db
      .select()
      .from(plansTable)
      .where(and(eq(plansTable.id, planId), eq(plansTable.isActive, true)))
      .limit(1);
    if (!newPlan) {
      res.status(404).json({ error: "Paket tidak ditemukan / tidak aktif" });
      return;
    }

    const [owner] = await db
      .select({ plan: usersTable.plan })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);
    if (owner?.plan === newPlan.key) {
      res.status(400).json({ error: "Anda sudah menggunakan paket ini." });
      return;
    }

    // Current plan price/label drives the prorated credit (0 if none/unknown).
    let oldPriceIdr = 0;
    let oldLabel = "paket lama";
    if (owner?.plan) {
      const [cur] = await db
        .select({ name: plansTable.name, priceIdr: plansTable.priceIdr })
        .from(plansTable)
        .where(eq(plansTable.key, owner.plan))
        .limit(1);
      if (cur) {
        oldPriceIdr = cur.priceIdr;
        oldLabel = `Paket ${cur.name}`;
      }
    }

    const quota = await getOrCreateTenantQuota(ownerUserId);
    const now = new Date();
    // Without a bounded period window we can't prorate; apply the swap directly.
    if (!quota.periodStart || !quota.periodEnd) {
      await applyPlanProration(ownerUserId, newPlan);
      res.json({ mode: "applied", invoiceId: null, creditIdr: null });
      return;
    }

    const { netIdr } = buildProrationLines(
      oldPriceIdr,
      newPlan.priceIdr,
      oldLabel,
      `Paket ${newPlan.name}`,
      now,
      quota.periodStart,
      quota.periodEnd
    );

    // Downgrade / no-cost change: apply immediately. Any prorated difference
    // becomes wallet credit (never a cash refund).
    if (netIdr <= 0) {
      if (netIdr < 0) {
        // Plan swap + prorated wallet credit must be all-or-nothing: a failed
        // credit insert after the swap would downgrade the tenant without ever
        // crediting the prorated difference (silent financial loss).
        await db.transaction(async (tx) => {
          await applyPlanProration(ownerUserId, newPlan, tx);
          await recordWalletTransaction(
            ownerUserId,
            -netIdr,
            "proration_credit",
            { sourceRef: `plan-change:${newPlan.id}` },
            tx
          );
        });
        res.json({ mode: "credit", creditIdr: -netIdr, invoiceId: null });
        return;
      }
      await applyPlanProration(ownerUserId, newPlan);
      res.json({ mode: "applied", creditIdr: null, invoiceId: null });
      return;
    }

    // Upgrade: raise a prorated OPEN invoice for the net charge only (the credit
    // for the old plan is netted into it). The plan swap is deferred until paid.
    const chargeLines = buildProrationLines(
      oldPriceIdr,
      newPlan.priceIdr,
      oldLabel,
      `Paket ${newPlan.name}`,
      now,
      quota.periodStart,
      quota.periodEnd
    ).lines;
    const { id: invId, totalIdr } = await createOpenProrationInvoice(
      ownerUserId,
      chargeLines,
      { t: "plan", planId: newPlan.id }
    );
    const detail = await getInvoiceForOwner(ownerUserId, invId);
    if (!detail) {
      res.status(500).json({ error: "Gagal membuat invoice prorata" });
      return;
    }

    // Wallet-first full cover → settle now (change applied immediately).
    const balance = await getWalletBalance(ownerUserId);
    if (balance >= totalIdr && totalIdr > 0) {
      const paymentId = await settleInvoiceByWallet(
        ownerUserId,
        invId,
        totalIdr,
        "proration"
      );
      if (paymentId !== null) {
        res.json({ mode: "applied", invoiceId: invId, creditIdr: null });
        return;
      }
    }

    const redirect = resolveRedirectUrl(parsed.data.successRedirectUrl);
    const outcome = await startInvoiceGatewayCheckout(
      ownerUserId,
      detail.invoice,
      "proration",
      redirect
    );
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    res.json({ mode: "charge", invoiceId: invId, checkout: outcome.checkout });
  } catch (err) {
    req.log.error({ err }, "changeMyPlan failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /billing/change-quota — add a prorated add-on top-up mid-period. Raises a
// prorated OPEN invoice for the remaining days and tries wallet-first, else
// returns a checkout to pay. The top-up applies only once paid.
router.post("/change-quota", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    if (await isInfinityOwner(ownerUserId)) {
      res.status(400).json({ error: "Akun ini tidak ditagih." });
      return;
    }

    const parsed = ChangeMyQuotaBody.safeParse(req.body);
    if (
      !parsed.success ||
      !Number.isInteger(parsed.data.addonId) ||
      !Number.isInteger(parsed.data.quantity) ||
      parsed.data.quantity < 1
    ) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const { addonId, quantity } = parsed.data;

    const [addon] = await db
      .select()
      .from(addonsTable)
      .where(and(eq(addonsTable.id, addonId), eq(addonsTable.isActive, true)))
      .limit(1);
    if (!addon) {
      res.status(404).json({ error: "Add-on tidak ditemukan / tidak aktif" });
      return;
    }

    const quota = await getOrCreateTenantQuota(ownerUserId);
    const now = new Date();
    // No period window → apply the top-up directly (no proration possible).
    if (!quota.periodStart || !quota.periodEnd) {
      await addAddonToQuota(ownerUserId, addon, quantity);
      res.json({ mode: "applied", invoiceId: null, creditIdr: null });
      return;
    }

    const { lines, netIdr } = buildProrationLines(
      0,
      addon.priceIdr * quantity,
      "",
      `Add-on ${addon.name}${quantity > 1 ? ` x${quantity}` : ""}`,
      now,
      quota.periodStart,
      quota.periodEnd
    );

    // Free / zero-cost add-on: apply immediately, no invoice.
    if (netIdr <= 0) {
      await addAddonToQuota(ownerUserId, addon, quantity);
      res.json({ mode: "applied", invoiceId: null, creditIdr: null });
      return;
    }

    const { id: invId, totalIdr } = await createOpenProrationInvoice(
      ownerUserId,
      lines,
      { t: "addon", addonId: addon.id, quantity }
    );
    const detail = await getInvoiceForOwner(ownerUserId, invId);
    if (!detail) {
      res.status(500).json({ error: "Gagal membuat invoice prorata" });
      return;
    }

    const balance = await getWalletBalance(ownerUserId);
    if (balance >= totalIdr && totalIdr > 0) {
      const paymentId = await settleInvoiceByWallet(
        ownerUserId,
        invId,
        totalIdr,
        "proration"
      );
      if (paymentId !== null) {
        res.json({ mode: "applied", invoiceId: invId, creditIdr: null });
        return;
      }
    }

    const redirect = resolveRedirectUrl(parsed.data.successRedirectUrl);
    const outcome = await startInvoiceGatewayCheckout(
      ownerUserId,
      detail.invoice,
      "proration",
      redirect
    );
    if (!outcome.ok) {
      res.status(outcome.status).json(outcome.body);
      return;
    }
    res.json({ mode: "charge", invoiceId: invId, checkout: outcome.checkout });
  } catch (err) {
    req.log.error({ err }, "changeMyQuota failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
