import { db, retentionSettingsTable, tenantQuotaTable, plansTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// The four retention knobs a tenant can configure. Each is a max age in DAYS,
// or null = unlimited (keep forever).
export type RetentionPolicy = {
  chatDays: number | null;
  mediaDays: number | null;
  logDays: number | null;
  analyticsDays: number | null;
};

const EMPTY_POLICY: RetentionPolicy = {
  chatDays: null,
  mediaDays: null,
  logDays: null,
  analyticsDays: null,
};

// Read the owner's retention policy, defaulting to unlimited when no row exists.
export async function getRetentionPolicy(
  ownerId: number
): Promise<RetentionPolicy> {
  const [row] = await db
    .select()
    .from(retentionSettingsTable)
    .where(eq(retentionSettingsTable.userId, ownerId))
    .limit(1);
  if (!row) return { ...EMPTY_POLICY };
  return {
    chatDays: row.chatDays,
    mediaDays: row.mediaDays,
    logDays: row.logDays,
    analyticsDays: row.analyticsDays,
  };
}

// Resolve the owner's plan retention cap (max selectable days). null = no cap
// (unlimited retention allowed). Reads the active plan via tenant_quota.planId.
export async function getPlanRetentionCap(
  ownerId: number
): Promise<number | null> {
  const [quota] = await db
    .select({ planId: tenantQuotaTable.planId })
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerId))
    .limit(1);
  if (!quota?.planId) return null;
  const [plan] = await db
    .select({ cap: plansTable.retentionLimitDays })
    .from(plansTable)
    .where(eq(plansTable.id, quota.planId))
    .limit(1);
  return plan?.cap ?? null;
}

// Clamp a tenant-chosen value against the plan cap. A null choice = unlimited;
// if the plan has a cap, unlimited becomes the cap and any larger choice is
// pulled down to it. A choice within the cap (or no cap) passes through.
export function clampToCap(
  chosen: number | null,
  cap: number | null
): number | null {
  if (cap == null) return chosen; // no cap → honor the choice (incl. unlimited)
  if (chosen == null) return cap; // unlimited not allowed → cap it
  return Math.min(chosen, cap);
}

// Apply the plan cap to an entire policy (used on save).
export function clampPolicy(
  policy: RetentionPolicy,
  cap: number | null
): RetentionPolicy {
  return {
    chatDays: clampToCap(policy.chatDays, cap),
    mediaDays: clampToCap(policy.mediaDays, cap),
    logDays: clampToCap(policy.logDays, cap),
    analyticsDays: clampToCap(policy.analyticsDays, cap),
  };
}
