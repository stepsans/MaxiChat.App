import { eq } from "drizzle-orm";
import {
  db,
  retentionSettingsTable,
  tenantQuotaTable,
  plansTable,
} from "@workspace/db";
import { logger } from "./logger";
import type { RetentionChoice } from "./retention-build";

// Read/write a tenant OWNER's data-retention policy (Billing v2 — FASE E). One
// row per owner; missing = unlimited for every class. The selectable age is
// bounded by the owner's active plan cap (`plans.retentionLimitDays`) — the
// purger applies min(chosen, cap) live, so a later downgrade tightens retention
// without rewriting the stored choice.

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Resolve the owner's stored choice. Never throws — missing row / read error →
// all-unlimited (keep forever), so a config problem can never purge data.
export async function getRetentionChoice(
  ownerUserId: number,
  exec: DbExecutor = db
): Promise<RetentionChoice> {
  try {
    const [row] = await exec
      .select()
      .from(retentionSettingsTable)
      .where(eq(retentionSettingsTable.userId, ownerUserId))
      .limit(1);
    if (!row) {
      return { chatDays: null, mediaDays: null, logDays: null, analyticsDays: null };
    }
    return {
      chatDays: row.chatDays,
      mediaDays: row.mediaDays,
      logDays: row.logDays,
      analyticsDays: row.analyticsDays,
    };
  } catch (err) {
    logger.error({ err, ownerUserId }, "getRetentionChoice failed; unlimited");
    return { chatDays: null, mediaDays: null, logDays: null, analyticsDays: null };
  }
}

// The owner's active plan retention cap (days), or null = unlimited. Read from
// tenant_quota.planId → plans.retentionLimitDays. Null when no plan on file.
export async function getRetentionCap(
  ownerUserId: number,
  exec: DbExecutor = db
): Promise<number | null> {
  const [quota] = await exec
    .select({ planId: tenantQuotaTable.planId })
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerUserId))
    .limit(1);
  if (!quota?.planId) return null;
  const [plan] = await exec
    .select({ cap: plansTable.retentionLimitDays })
    .from(plansTable)
    .where(eq(plansTable.id, quota.planId))
    .limit(1);
  return plan?.cap ?? null;
}

export type UpdateRetentionInput = {
  chatDays?: number | null;
  mediaDays?: number | null;
  logDays?: number | null;
  analyticsDays?: number | null;
};

// Atomic upsert of the owner's choice. Omitted fields are left unchanged; an
// explicit null clears (sets unlimited). Whole-day integers enforced by the
// route. Returns the resulting choice.
export async function updateRetentionChoice(
  ownerUserId: number,
  input: UpdateRetentionInput
): Promise<RetentionChoice> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.chatDays !== undefined) set.chatDays = input.chatDays;
  if (input.mediaDays !== undefined) set.mediaDays = input.mediaDays;
  if (input.logDays !== undefined) set.logDays = input.logDays;
  if (input.analyticsDays !== undefined) set.analyticsDays = input.analyticsDays;

  await db
    .insert(retentionSettingsTable)
    .values({
      userId: ownerUserId,
      chatDays: input.chatDays ?? null,
      mediaDays: input.mediaDays ?? null,
      logDays: input.logDays ?? null,
      analyticsDays: input.analyticsDays ?? null,
    })
    .onConflictDoUpdate({ target: retentionSettingsTable.userId, set });

  return getRetentionChoice(ownerUserId);
}
