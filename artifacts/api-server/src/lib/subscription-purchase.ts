import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  plansTable,
  addonsTable,
  tenantQuotaTable,
  subscriptionsTable,
  paymentsTable,
  invoicesTable,
  type PlanRow,
  type AddonRow,
  type PaymentRow,
  type InvoiceRow,
} from "@workspace/db";
import { logger } from "./logger";
import { createInvoiceForPayment } from "./invoices";
import { markInvoicePaid, clearDunningForOwner } from "./dunning";
import { decodeInvoiceDirective } from "./proration-directive";
import { grantCredits } from "./credit-wallet";
import { grantBooster } from "./token-boosters";

const DAY_MS = 24 * 60 * 60 * 1000;

// A db handle that may be the root connection OR an open transaction. Settlement
// runs entitlement application inside the same transaction as the pending→paid
// flip, so every mutating helper accepts the executor explicitly.
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Ensure a tenant_quota row exists for the owner and return it. Limits default
// to 0 (no plan purchased yet); a plan/add-on purchase fills them in.
export async function getOrCreateTenantQuota(
  ownerId: number,
  exec: DbExecutor = db
) {
  await exec
    .insert(tenantQuotaTable)
    .values({ userId: ownerId })
    .onConflictDoNothing({ target: tenantQuotaTable.userId });
  const [row] = await exec
    .select()
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerId))
    .limit(1);
  return row;
}

// The catalog's entry-level plan = lowest sortOrder among active plans (the
// canonical "entry-level first" ordering used across billing/plans routes).
export async function getEntryLevelPlan(
  exec: DbExecutor = db
): Promise<PlanRow | null> {
  const [plan] = await exec
    .select()
    .from(plansTable)
    .where(eq(plansTable.isActive, true))
    .orderBy(asc(plansTable.sortOrder), asc(plansTable.id))
    .limit(1);
  return plan ?? null;
}

// Provision a TRIAL tenant with the full entry-level plan grant (LOCKED spec
// A1/B: "rasakan nilai AI penuh" — not a tiny trial grant), so the C1 hard-block
// also applies during trial once the grant is spent. Sets the trial window
// (periodStart=now .. periodEnd=trialEnd) but NOT anchorDate — the anniversary
// anchor only locks at the first paid conversion. planId stays NULL so the
// monthly-close billing path never charges a trial. onConflictDoNothing: never
// clobber an existing quota row (e.g. a returning/converted tenant).
export async function provisionTrialQuota(
  ownerId: number,
  trialEnd: Date,
  exec: DbExecutor = db
): Promise<void> {
  const plan = await getEntryLevelPlan(exec);
  if (!plan) return; // No catalog yet — nothing to grant.
  const now = new Date();
  await exec
    .insert(tenantQuotaTable)
    .values({
      userId: ownerId,
      planId: null,
      tokenLimit: plan.quotaTokens,
      channelLimit: plan.quotaChannels,
      userLimit: plan.quotaUsers,
      storageLimit: plan.quotaStorageBytes,
      periodStart: now,
      periodEnd: trialEnd,
      anchorDate: null,
    })
    .onConflictDoNothing({ target: tenantQuotaTable.userId });
}

// Activate (or renew) a plan for an owner. This is the authoritative state
// transition when a plan payment is confirmed:
//   - users.plan      = plan.key (so the legacy per-plan seat cap keeps working)
//   - subscription    = active, period end pushed to max(now, end) + durationDays
//   - tenant_quota    = plan quotas (limits RESET to the plan baseline) for a
//                       fresh period aligned with the subscription end
// Add-ons bought later in the period top these limits up (see addAddonToQuota).
export async function activatePlanForOwner(
  ownerId: number,
  plan: PlanRow,
  exec: DbExecutor = db
): Promise<void> {
  const now = new Date();

  // Don't shorten an existing longer period — stack from the later of now / end.
  const [sub] = await exec
    .select({ currentPeriodEnd: subscriptionsTable.currentPeriodEnd })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, ownerId))
    .limit(1);
  const base =
    sub?.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime()
      ? sub.currentPeriodEnd
      : now;
  const periodEnd = new Date(base.getTime() + plan.durationDays * DAY_MS);

  await exec
    .update(usersTable)
    .set({ plan: plan.key })
    .where(eq(usersTable.id, ownerId));

  // Upsert subscription → active with the new period end.
  await exec
    .insert(subscriptionsTable)
    .values({ userId: ownerId, status: "active", currentPeriodEnd: periodEnd })
    .onConflictDoUpdate({
      target: subscriptionsTable.userId,
      set: { status: "active", currentPeriodEnd: periodEnd, updatedAt: now },
    });

  // Upsert tenant_quota → plan baseline limits for the fresh period.
  await exec
    .insert(tenantQuotaTable)
    .values({
      userId: ownerId,
      planId: plan.id,
      tokenLimit: plan.quotaTokens,
      channelLimit: plan.quotaChannels,
      userLimit: plan.quotaUsers,
      storageLimit: plan.quotaStorageBytes,
      periodStart: now,
      periodEnd,
      // First conversion → this is the locked anniversary anchor (spec A1).
      anchorDate: now,
    })
    .onConflictDoUpdate({
      target: tenantQuotaTable.userId,
      set: {
        planId: plan.id,
        tokenLimit: plan.quotaTokens,
        channelLimit: plan.quotaChannels,
        userLimit: plan.quotaUsers,
        storageLimit: plan.quotaStorageBytes,
        periodStart: now,
        periodEnd,
        // LOCK the anchor: keep the existing first-conversion date forever;
        // only set it now if this row never had one (e.g. a pre-anchor tenant).
        anchorDate: sql`COALESCE(${tenantQuotaTable.anchorDate}, ${now})`,
        updatedAt: now,
      },
    });

  // SPEC BAGIAN 9: the plan's token allowance becomes a GRANT (Ember A) of AI
  // credits, reset each period and expiring at the period end (spent before
  // purchased paid credits). 1 quota-token = 1 credit grant. tokenLimit above is
  // now informational only (AI is gated by the wallet, not tokenLimit).
  await grantCredits(
    { ownerUserId: ownerId, amount: plan.quotaTokens, expiresAt: periodEnd, now },
    exec,
  );
}

// Apply a mid-period PLAN SWITCH via proration (Billing v2 — FASE D). Unlike
// activatePlanForOwner, this does NOT extend the period — the tenant already
// paid for the running period; proration only covers the upgrade delta for the
// remaining days. So we swap users.plan + reset the quota LIMITS to the new
// plan baseline but KEEP the current period window. Add-ons bought separately
// still top up afterwards.
export async function applyPlanProration(
  ownerId: number,
  plan: PlanRow,
  exec: DbExecutor = db
): Promise<void> {
  const now = new Date();
  await exec
    .update(usersTable)
    .set({ plan: plan.key })
    .where(eq(usersTable.id, ownerId));

  // Preserve the existing period window (don't extend); only reset limits.
  const [quota] = await exec
    .select({
      periodStart: tenantQuotaTable.periodStart,
      periodEnd: tenantQuotaTable.periodEnd,
    })
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerId))
    .limit(1);

  await exec
    .insert(tenantQuotaTable)
    .values({
      userId: ownerId,
      planId: plan.id,
      tokenLimit: plan.quotaTokens,
      channelLimit: plan.quotaChannels,
      userLimit: plan.quotaUsers,
      storageLimit: plan.quotaStorageBytes,
      periodStart: quota?.periodStart ?? now,
      periodEnd: quota?.periodEnd ?? null,
    })
    .onConflictDoUpdate({
      target: tenantQuotaTable.userId,
      set: {
        planId: plan.id,
        tokenLimit: plan.quotaTokens,
        channelLimit: plan.quotaChannels,
        userLimit: plan.quotaUsers,
        storageLimit: plan.quotaStorageBytes,
        updatedAt: now,
      },
    });

  // Make sure the subscription is active (a proration upgrade implies paying).
  await exec
    .update(subscriptionsTable)
    .set({ status: "active", updatedAt: now })
    .where(eq(subscriptionsTable.userId, ownerId));
}

// Apply the deferred entitlement directive stored on a now-paid OPEN invoice
// (proration charge). Plain bills (null directive) change nothing.
export async function applyInvoiceDirective(
  invoice: InvoiceRow,
  exec: DbExecutor = db
): Promise<void> {
  const directive = decodeInvoiceDirective(invoice.notes);
  if (!directive) return;
  if (directive.t === "plan") {
    const [plan] = await exec
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, directive.planId))
      .limit(1);
    if (!plan) throw new Error(`proration: plan ${directive.planId} not found`);
    await applyPlanProration(invoice.userId, plan, exec);
    return;
  }
  // addon top-up
  const [addon] = await exec
    .select()
    .from(addonsTable)
    .where(eq(addonsTable.id, directive.addonId))
    .limit(1);
  if (!addon) throw new Error(`proration: addon ${directive.addonId} not found`);
  await addAddonToQuota(invoice.userId, addon, directive.quantity, exec);
}

// Apply an add-on top-up: increment the matching limit by unitAmount * quantity.
// Requires a tenant_quota row (created if missing). Add-ons may push limits past
// the plan quota by design (the Hybrid model allows exceeding the base plan).
export async function addAddonToQuota(
  ownerId: number,
  addon: AddonRow,
  quantity: number,
  exec: DbExecutor = db
): Promise<void> {
  const delta = addon.unitAmount * Math.max(1, quantity);
  const now = new Date();

  // LOCKED spec B: a 'token' add-on is a paid BOOSTER (Ember B) — a separate
  // bucket with its own 90-day expiry that carries across billing periods, NOT a
  // grant top-up of tenant_quota.tokenLimit (which lapses each period). Created
  // inside the settlement txn so the booster is atomic with the paid flip.
  if (addon.type === "token") {
    await grantBooster({ ownerUserId: ownerId, amountTokens: delta, now }, exec);
    return;
  }

  await getOrCreateTenantQuota(ownerId, exec);
  const set: Partial<typeof tenantQuotaTable.$inferInsert> = { updatedAt: now };
  if (addon.type === "channel") {
    set.channelLimit = sql`${tenantQuotaTable.channelLimit} + ${delta}` as never;
  } else if (addon.type === "user_seat") {
    set.userLimit = sql`${tenantQuotaTable.userLimit} + ${delta}` as never;
  } else if (addon.type === "storage") {
    set.storageLimit = sql`${tenantQuotaTable.storageLimit} + ${delta}` as never;
  } else {
    throw new Error(`Unknown add-on type: ${addon.type}`);
  }

  await exec
    .update(tenantQuotaTable)
    .set(set)
    .where(eq(tenantQuotaTable.userId, ownerId));
}

// Apply a confirmed (paid) payment's effect on the tenant's subscription/quota.
// Dispatched by kind. The caller is responsible for the idempotency guard (only
// invoking this on the pending→paid transition).
export async function applyPaidPayment(
  payment: PaymentRow,
  exec: DbExecutor = db
): Promise<void> {
  if (payment.kind === "plan") {
    if (payment.refId == null) {
      throw new Error(`plan payment ${payment.id} has no refId`);
    }
    const [plan] = await exec
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, payment.refId))
      .limit(1);
    if (!plan) throw new Error(`plan ${payment.refId} not found`);
    await activatePlanForOwner(payment.userId, plan, exec);
    return;
  }

  if (payment.kind === "addon") {
    if (payment.refId == null) {
      throw new Error(`addon payment ${payment.id} has no refId`);
    }
    const [addon] = await exec
      .select()
      .from(addonsTable)
      .where(eq(addonsTable.id, payment.refId))
      .limit(1);
    if (!addon) throw new Error(`addon ${payment.refId} not found`);
    await addAddonToQuota(payment.userId, addon, payment.quantity, exec);
    return;
  }

  if (payment.kind === "cart") {
    const items = payment.lineItems ?? [];
    if (items.length === 0) {
      throw new Error(`cart payment ${payment.id} has no line items`);
    }
    // Apply plans before add-ons: activating a plan RESETS quota to the plan
    // baseline, so any add-on top-ups bought in the same cart must be applied
    // afterwards or they'd be wiped out.
    const plans = items.filter((it) => it.kind === "plan");
    if (plans.length > 1) {
      throw new Error(`cart payment ${payment.id} has more than one plan`);
    }
    for (const plan of plans) {
      const [row] = await exec
        .select()
        .from(plansTable)
        .where(eq(plansTable.id, plan.refId))
        .limit(1);
      if (!row) throw new Error(`cart plan ${plan.refId} not found`);
      await activatePlanForOwner(payment.userId, row, exec);
    }
    for (const item of items.filter((it) => it.kind === "addon")) {
      const [row] = await exec
        .select()
        .from(addonsTable)
        .where(eq(addonsTable.id, item.refId))
        .limit(1);
      if (!row) throw new Error(`cart addon ${item.refId} not found`);
      await addAddonToQuota(payment.userId, row, item.quantity, exec);
    }
    return;
  }

  if (payment.kind === "renewal") {
    // A plain renewal re-activates the owner's current plan (extends the
    // period + resets quota to the plan baseline). If no plan is on file we
    // can't infer a duration, so just log — nothing to grant.
    const [quota] = await exec
      .select({ planId: tenantQuotaTable.planId })
      .from(tenantQuotaTable)
      .where(eq(tenantQuotaTable.userId, payment.userId))
      .limit(1);
    if (quota?.planId == null) {
      logger.warn(
        { paymentId: payment.id, ownerId: payment.userId },
        "renewal payment with no current plan — nothing to apply"
      );
      return;
    }
    const [plan] = await exec
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, quota.planId))
      .limit(1);
    if (!plan) throw new Error(`renewal: plan ${quota.planId} not found`);
    await activatePlanForOwner(payment.userId, plan, exec);
    return;
  }

  if (payment.kind === "invoice" || payment.kind === "proration") {
    // Collecting an existing OPEN invoice (an overdue monthly_close bill, or a
    // proration charge raised by change-plan/change-quota). refId = invoice id.
    if (payment.refId == null) {
      throw new Error(`invoice payment ${payment.id} has no refId`);
    }
    const invoice = await markInvoicePaid(payment.refId, exec);
    if (invoice) {
      // Link the collected payment to the (previously paymentId-null) invoice
      // for traceability, then apply any deferred entitlement directive.
      await exec
        .update(invoicesTable)
        .set({ paymentId: payment.id })
        .where(eq(invoicesTable.id, invoice.id));
      await applyInvoiceDirective(invoice, exec);
    }
    // Paying any open invoice clears dunning (and un-suspends if nothing else
    // is overdue + the period still has runway).
    await clearDunningForOwner(payment.userId, exec);
    return;
  }

  throw new Error(`Unknown payment kind: ${payment.kind}`);
}

// Idempotently mark a pending payment paid and apply its effect. Returns true
// when THIS call performed the transition (so the caller knows it's the first
// time), false if the payment was already paid/non-pending. The conditional
// update (WHERE status='pending') is the idempotency guard — a webhook arriving
// twice updates 0 rows the second time.
export async function settlePaymentPaid(
  paymentId: number,
  rawPayload: unknown
): Promise<boolean> {
  // Atomic: the pending→paid flip AND the entitlement grant run in one
  // transaction. If applyPaidPayment throws (e.g. the referenced plan/add-on
  // was deleted between checkout and settlement), the whole transaction rolls
  // back — the payment stays `pending` so a later webhook retry can re-attempt,
  // instead of being stuck `paid` with no quota granted (charged-but-empty).
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(paymentsTable)
      .set({
        status: "paid",
        paidAt: new Date(),
        rawPayload: rawPayload as never,
        updatedAt: new Date(),
      })
      .where(
        and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending"))
      )
      .returning();
    if (updated.length === 0) return false;
    await applyPaidPayment(updated[0], tx);
    // Raise the immutable invoice in the SAME transaction as the settlement, so
    // a paid payment and its financial record are all-or-nothing (idempotent
    // via the unique payment_id index — a webhook retry is a no-op).
    //
    // EXCEPTION: invoice/proration payments COLLECT an invoice that already
    // exists (applyPaidPayment marked it paid + linked it). Calling
    // createInvoiceForPayment here would raise a SECOND, duplicate invoice for
    // the same financial event, so skip it for those kinds.
    if (updated[0].kind !== "invoice" && updated[0].kind !== "proration") {
      await createInvoiceForPayment(updated[0], tx);
    }
    return true;
  });
}

// Mark a pending payment expired/failed (no quota effect). Idempotent.
export async function settlePaymentTerminal(
  paymentId: number,
  status: "expired" | "failed",
  rawPayload: unknown
): Promise<void> {
  await db
    .update(paymentsTable)
    .set({ status, rawPayload: rawPayload as never, updatedAt: new Date() })
    .where(
      and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending"))
    );
}
