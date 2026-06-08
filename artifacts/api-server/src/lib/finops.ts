import { and, eq, gte, inArray, isNull, ne, lt, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  plansTable,
  subscriptionsTable,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import { computeEffectiveStatus } from "./billing-engine";
import {
  recognizedInPeriod,
  type RecognizableLine,
} from "./revenue-recognize";

// FinOps metrics (Billing v2 — FASE H). Sourced from the IMMUTABLE invoice
// ledger (billings + recognized revenue) plus live subscriptions/plans for the
// run-rate MRR. Kept separate from the legacy snapshot-based computeRevenue so
// the existing admin dashboard keeps working unchanged; this is the new,
// invoice-grounded source of truth surfaced under /admin/finops.
//
// - billings:   cash collected = sum(paid invoices.total) whose paidAt is in the
//               window. This is "what we charged", straight off the ledger.
// - recognized: revenue EARNED in the window — over-time lines (plan/proration
//               with a covers window) accrue per-day; point-in-time lines
//               (usage/booster) recognize on issue. Until proration/monthly_close
//               populate covers windows, payment lines recognize immediately, so
//               recognized≈billings; it diverges once windows exist.
// - mrr:        run-rate from ACTIVE tenants' current plan, normalized to 30d
//               (plan.priceIdr / plan.durationDays × 30). Independent of invoices
//               so a brand-new (not-yet-billed) tenant still counts.

export type FinopsSummary = {
  periodDays: number;
  // Tenant counts by effective status.
  totalTenants: number;
  activeTenants: number;
  trialTenants: number;
  pastDueTenants: number;
  suspendedTenants: number;
  expiredTenants: number;
  // Money (whole Rupiah).
  mrr: number;
  arr: number;
  arpu: number;
  billings: number;
  recognizedRevenue: number;
  // Retention.
  churnedTenants: number;
  churnRatePct: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function computeFinops(
  periodDays = 30,
  now: Date = new Date()
): Promise<FinopsSummary> {
  const since = new Date(now.getTime() - periodDays * DAY_MS);

  // Tenant owners only: parent-null AND not the platform admin (role="admin").
  const owners = await db
    .select({
      id: usersTable.id,
      plan: usersTable.plan,
      status: subscriptionsTable.status,
      currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
    })
    .from(usersTable)
    .leftJoin(subscriptionsTable, eq(subscriptionsTable.userId, usersTable.id))
    .where(and(isNull(usersTable.parentUserId), ne(usersTable.role, "admin")));

  // Plan price/duration lookup by users.plan key (run-rate MRR base).
  const plans = await db
    .select({
      key: plansTable.key,
      priceIdr: plansTable.priceIdr,
      durationDays: plansTable.durationDays,
    })
    .from(plansTable);
  const planByKey = new Map(plans.map((p) => [p.key, p]));

  let activeTenants = 0;
  let trialTenants = 0;
  let pastDueTenants = 0;
  let suspendedTenants = 0;
  let expiredTenants = 0;
  let churnedTenants = 0;
  let mrr = 0;

  for (const o of owners) {
    const rawStatus = o.status ?? "active";
    const eff = computeEffectiveStatus(
      rawStatus,
      o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
      now
    );
    if (eff === "active") {
      activeTenants++;
      const p = o.plan ? planByKey.get(o.plan) : undefined;
      if (p && p.durationDays > 0) {
        mrr += Math.round((p.priceIdr / p.durationDays) * 30);
      }
    } else if (eff === "trial") {
      trialTenants++;
    } else if (eff === "suspended") {
      suspendedTenants++;
    } else {
      expiredTenants++;
    }
    // Churn proxy: a non-active tenant whose period lapsed within the window.
    if (
      (eff === "expired" || eff === "suspended") &&
      o.currentPeriodEnd != null &&
      o.currentPeriodEnd.getTime() >= since.getTime() &&
      o.currentPeriodEnd.getTime() <= now.getTime()
    ) {
      churnedTenants++;
    }
    if (rawStatus === "past_due") pastDueTenants++;
  }

  const arpu = activeTenants > 0 ? Math.round(mrr / activeTenants) : 0;
  const churnBase = activeTenants + churnedTenants;
  const churnRatePct =
    churnBase > 0 ? Math.round((churnedTenants / churnBase) * 1000) / 10 : 0;

  // Billings: paid invoices in the window (by paidAt).
  const [billRow] = await db
    .select({
      total: sql<number>`cast(coalesce(sum(${invoicesTable.totalIdr}), 0) as bigint)`,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.status, "paid"),
        gte(invoicesTable.paidAt, since)
      )
    );
  const billings = Number(billRow?.total ?? 0);

  // Recognized revenue: pull paid-invoice lines that could overlap the window
  // (issued in/after the window, OR an over-time line whose coverage reaches
  // into it) and run the pure recognizer.
  const lineRows = await db
    .select({
      amountIdr: invoiceLineItemsTable.amountIdr,
      lineType: invoiceLineItemsTable.lineType,
      coversFrom: invoiceLineItemsTable.coversFrom,
      coversTo: invoiceLineItemsTable.coversTo,
      issuedAt: invoicesTable.issuedAt,
    })
    .from(invoiceLineItemsTable)
    .innerJoin(
      invoicesTable,
      eq(invoiceLineItemsTable.invoiceId, invoicesTable.id)
    )
    .where(
      and(
        ne(invoicesTable.status, "void"),
        sql`(${invoiceLineItemsTable.coversTo} is null and ${invoicesTable.issuedAt} >= ${since.toISOString()})
            or (${invoiceLineItemsTable.coversTo} is not null and ${invoiceLineItemsTable.coversTo} >= ${since.toISOString()})`
      )
    );

  const recLines: RecognizableLine[] = lineRows.map((r) => ({
    amountIdr: r.amountIdr,
    lineType: r.lineType,
    coversFrom: r.coversFrom,
    coversTo: r.coversTo,
    issuedAt: r.issuedAt,
  }));
  const recognizedRevenue = recognizedInPeriod(recLines, since, now);

  return {
    periodDays,
    totalTenants: owners.length,
    activeTenants,
    trialTenants,
    pastDueTenants,
    suspendedTenants,
    expiredTenants,
    mrr,
    arr: mrr * 12,
    arpu,
    billings,
    recognizedRevenue,
    churnedTenants,
    churnRatePct,
  };
}
