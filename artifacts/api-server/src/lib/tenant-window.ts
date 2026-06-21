import { eq } from "drizzle-orm";
import { db, usersTable, tenantQuotaTable } from "@workspace/db";
import { computeBillingPeriod } from "./billing-period";

export interface BillingWindow {
  start: Date;
  end: Date;
}

// The authoritative billing window for an owner (spec A1). Precedence:
//   1) anchorDate — the LOCKED first-conversion anniversary. The current period
//      is computed live from its day-of-month, so upgrades/downgrades never
//      shift it and no scheduler is needed to roll it forward.
//   2) periodStart/periodEnd columns — a provisioned (trial or legacy) window.
//   3) computeBillingPeriod(joinDate) — last-resort fallback for unprovisioned
//      tenants. This is NOT the anchor; it just keeps the figure sane until a
//      window exists. (Closing the old drift bug: joinDate is no longer the
//      anchor for provisioned tenants.)
export function resolveBillingWindow(
  quota:
    | { periodStart: Date | null; periodEnd: Date | null; anchorDate?: Date | null }
    | undefined,
  ownerCreatedAt: Date,
  now: Date
): BillingWindow {
  if (quota?.anchorDate) {
    return computeBillingPeriod(quota.anchorDate, now);
  }
  if (quota?.periodStart && quota.periodEnd) {
    return { start: quota.periodStart, end: quota.periodEnd };
  }
  return computeBillingPeriod(ownerCreatedAt, now);
}

// Fetch + resolve an owner's current billing window in one call. Used by the
// booster consumption path (which has only the ownerId in hand).
export async function getOwnerBillingWindow(
  ownerUserId: number,
  now: Date = new Date()
): Promise<BillingWindow | null> {
  const [row] = await db
    .select({
      createdAt: usersTable.createdAt,
      periodStart: tenantQuotaTable.periodStart,
      periodEnd: tenantQuotaTable.periodEnd,
      anchorDate: tenantQuotaTable.anchorDate,
    })
    .from(usersTable)
    .leftJoin(tenantQuotaTable, eq(tenantQuotaTable.userId, usersTable.id))
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);
  if (!row) return null;
  return resolveBillingWindow(
    {
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      anchorDate: row.anchorDate,
    },
    row.createdAt,
    now
  );
}
