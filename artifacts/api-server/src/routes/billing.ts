import { Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  plansTable,
  addonsTable,
  paymentsTable,
  tenantQuotaTable,
} from "@workspace/db";
import { CreateCheckoutBody } from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  computeOwnerBill,
  computeOwnerUsage,
  getEffectiveSubscription,
  computeOwnerTrend,
} from "../lib/billing";
import { getOrCreateTenantQuota } from "../lib/subscription-purchase";
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

    const [subscription, bill] = await Promise.all([
      getEffectiveSubscription(ownerUserId),
      computeOwnerBill(ownerUserId),
    ]);

    res.json({
      subscription,
      usage: bill.usage,
      pricing: bill.pricing,
      breakdown: bill.breakdown,
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

    let planKey: string | null = null;
    let planName: string | null = null;
    if (quota.planId != null) {
      const [plan] = await db
        .select({ key: plansTable.key, name: plansTable.name })
        .from(plansTable)
        .where(eq(plansTable.id, quota.planId))
        .limit(1);
      planKey = plan?.key ?? null;
      planName = plan?.name ?? null;
    }

    const usage = await computeOwnerUsage(ownerUserId);

    res.json({
      planId: quota.planId,
      planKey,
      planName,
      tokenLimit: quota.tokenLimit,
      channelLimit: quota.channelLimit,
      userLimit: quota.userLimit,
      periodStart: quota.periodStart,
      periodEnd: quota.periodEnd,
      usage,
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
    const { kind, refId } = parsed.data;
    const quantity = kind === "addon" ? parsed.data.quantity ?? 1 : 1;

    // OpenAPI `integer` codegens to zod.number() (accepts decimals), so a
    // fractional quantity/refId would slip through and make amountIdr
    // non-integer. Money must stay whole-Rupiah; reject non-integers here.
    if (!Number.isInteger(refId) || refId < 1) {
      res.status(400).json({ error: "refId tidak valid" });
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      res.status(400).json({ error: "Jumlah harus bilangan bulat ≥ 1" });
      return;
    }

    const provider = await getActiveProvider();

    const ownerUserId = await resolveOwnerUserId(userId);

    // Resolve the catalog item, compute amount + description server-side.
    let amountIdr: number;
    let description: string;
    if (kind === "plan") {
      const [plan] = await db
        .select()
        .from(plansTable)
        .where(and(eq(plansTable.id, refId), eq(plansTable.isActive, true)))
        .limit(1);
      if (!plan) {
        res.status(404).json({ error: "Paket tidak ditemukan / tidak aktif" });
        return;
      }
      amountIdr = plan.priceIdr;
      description = `Paket ${plan.name}`;
    } else {
      const [addon] = await db
        .select()
        .from(addonsTable)
        .where(and(eq(addonsTable.id, refId), eq(addonsTable.isActive, true)))
        .limit(1);
      if (!addon) {
        res.status(404).json({ error: "Add-on tidak ditemukan / tidak aktif" });
        return;
      }
      amountIdr = addon.priceIdr * quantity;
      description = `Add-on ${addon.name}${quantity > 1 ? ` x${quantity}` : ""}`;
    }

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
          kind,
          refId,
          quantity,
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
        kind,
        refId,
        quantity,
        amountIdr,
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

export default router;
