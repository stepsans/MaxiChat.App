import { and, asc, eq, isNull, ne } from "drizzle-orm";
import {
  db,
  usersTable,
  subscriptionsTable,
  tenantQuotaTable,
  plansTable,
  addonsTable,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { computeBillingPeriod } from "./billing-period";
import { computeEffectiveStatus } from "./billing-engine";
import { isInfinityOwner } from "./infinity-owner";
import { invoiceTotals } from "./invoice-build";
import {
  buildMonthlyCloseLines,
  monthlyCloseInvoiceNumber,
  type AddonPricingByType,
} from "./monthly-close-build";

// Monthly billing close (Billing v2 — FASE B). A scheduler raises ONE
// `monthly_close` invoice per active tenant per billing period, reflecting the
// tenant's active plan + standing add-ons. This is the recurring-revenue record
// (MRR/ARR source for FASE H), raised independently of one-off payments.
//
// Idempotency is structural: monthlyCloseInvoiceNumber is deterministic per
// (owner, period), and invoices.invoice_number is UNIQUE — so a re-run on the
// same period inserts 0 rows (onConflictDoNothing). No (owner, period) tracking
// table is needed.

// Build (or no-op) the monthly-close invoice for ONE owner for the period that
// contains `now`. Returns the new invoice id, or null when there is nothing to
// bill (no active plan) or the invoice already exists for this period.
export async function runMonthlyCloseForOwner(
  ownerId: number,
  now: Date = new Date()
): Promise<number | null> {
  const [owner] = await db
    .select({ createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  if (!owner) return null;

  // The active plan is recorded on tenant_quota.planId. No plan → the tenant
  // has never purchased a subscription, so there is no recurring charge.
  const [quota] = await db
    .select()
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerId))
    .limit(1);
  if (!quota || quota.planId == null) return null;

  const [plan] = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.id, quota.planId))
    .limit(1);
  if (!plan) return null;

  const { start, end } = computeBillingPeriod(owner.createdAt ?? now, now);

  // Representative active add-on per type (lowest id wins), used to price the
  // standing quota top-ups above the plan base.
  const addonRows = await db
    .select()
    .from(addonsTable)
    .where(eq(addonsTable.isActive, true))
    .orderBy(asc(addonsTable.id));
  const byType: AddonPricingByType = {};
  for (const a of addonRows) {
    const pricing = {
      id: a.id,
      name: a.name,
      unitAmount: a.unitAmount,
      priceIdr: a.priceIdr,
    };
    if (a.type === "token" && !byType.token) byType.token = pricing;
    else if (a.type === "channel" && !byType.channel) byType.channel = pricing;
    else if (a.type === "user_seat" && !byType.user_seat)
      byType.user_seat = pricing;
    else if (a.type === "storage" && !byType.storage) byType.storage = pricing;
  }

  const lines = buildMonthlyCloseLines(
    {
      id: plan.id,
      name: plan.name,
      priceIdr: plan.priceIdr,
      quotaTokens: plan.quotaTokens,
      quotaChannels: plan.quotaChannels,
      quotaUsers: plan.quotaUsers,
      quotaStorageBytes: plan.quotaStorageBytes,
    },
    {
      tokenLimit: quota.tokenLimit,
      channelLimit: quota.channelLimit,
      userLimit: quota.userLimit,
      storageLimit: quota.storageLimit,
    },
    byType
  );
  const { subtotalIdr, taxIdr, totalIdr } = invoiceTotals(lines);
  const invoiceNumber = monthlyCloseInvoiceNumber(ownerId, start);

  // Invoice + its line items are all-or-nothing in one transaction. The unique
  // invoice_number makes a re-run for the same period a no-op (0 rows inserted).
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(invoicesTable)
      .values({
        userId: ownerId,
        invoiceNumber,
        source: "monthly_close",
        paymentId: null,
        status: "open",
        currency: "IDR",
        subtotalIdr,
        taxIdr,
        totalIdr,
        periodStart: start,
        periodEnd: end,
        issuedAt: now,
        paidAt: null,
      })
      .onConflictDoNothing({ target: invoicesTable.invoiceNumber })
      .returning({ id: invoicesTable.id });

    if (inserted.length === 0) return null;

    const invoiceId = inserted[0].id;
    if (lines.length > 0) {
      await tx.insert(invoiceLineItemsTable).values(
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
  });
}

export interface MonthlyCloseResult {
  created: number;
  skipped: number;
  errors: number;
}

// Run the monthly close across every eligible tenant for the period containing
// `now`. Eligible = a tenant OWNER (parent_user_id NULL, not the platform
// admin) whose EFFECTIVE subscription status is "active". Infinity owners are
// never billed, so they are skipped. Each owner is closed independently; one
// owner's failure never aborts the rest.
export async function runMonthlyClose(
  now: Date = new Date()
): Promise<MonthlyCloseResult> {
  const owners = await db
    .select({
      id: usersTable.id,
      status: subscriptionsTable.status,
      currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
    })
    .from(usersTable)
    .leftJoin(subscriptionsTable, eq(subscriptionsTable.userId, usersTable.id))
    .where(and(isNull(usersTable.parentUserId), ne(usersTable.role, "admin")));

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const o of owners) {
    // Lazily-missing subscription rows default to "active" (getOrCreate's
    // default), matching the revenue aggregate's treatment.
    const eff = computeEffectiveStatus(
      o.status ?? "active",
      o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
      now
    );
    if (eff !== "active") {
      skipped++;
      continue;
    }
    // Infinity owners are unlimited + never billed — no recurring invoice.
    if (await isInfinityOwner(o.id)) {
      skipped++;
      continue;
    }
    try {
      const id = await runMonthlyCloseForOwner(o.id, now);
      if (id != null) created++;
      else skipped++;
    } catch (err) {
      logger.error({ err, ownerId: o.id }, "monthly close failed for owner");
      errors++;
    }
  }

  logger.info(
    { ownerCount: owners.length, created, skipped, errors },
    "monthly close complete"
  );
  return { created, skipped, errors };
}

// ----- Scheduler -----

let schedulerStarted = false;
let lastRunDate: string | null = null;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Daily ticker: a 1-hour interval checks the wall clock and runs the close at
// most once per UTC day (the run itself is idempotent per period, so the daily
// cadence simply guarantees a new period's invoice gets raised within a day of
// its anchor boundary). Self-dedups via lastRunDate so a mid-day restart re-runs
// at most once more.
export function startMonthlyCloseScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const tick = async (): Promise<void> => {
    const today = todayUtc();
    if (lastRunDate === today) return;
    lastRunDate = today;
    try {
      await runMonthlyClose();
    } catch (err) {
      logger.error({ err }, "monthly close scheduler tick failed");
      lastRunDate = null; // allow a retry on the next tick
    }
  };

  // First tick a little after boot, then hourly.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60 * 60 * 1000);
  }, 45_000);
  logger.info("monthly close scheduler started");
}
