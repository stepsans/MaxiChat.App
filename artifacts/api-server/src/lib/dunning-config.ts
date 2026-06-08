import { eq } from "drizzle-orm";
import { db, dunningSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import type { DunningSchedule } from "./dunning-build";
import { DEFAULT_DUNNING_SCHEDULE } from "./dunning-build";

// Platform-level dunning policy (Billing v2 — FASE F). SINGLETON row id=1.
// Default-disabled: `enabled=false` → the sweep is a no-op (no tenant is ever
// auto-suspended) until the operator turns it on. Mirrors tax/overage config.

export type DunningSettings = {
  enabled: boolean;
  schedule: DunningSchedule;
};

export const DUNNING_DISABLED: DunningSettings = {
  enabled: false,
  schedule: DEFAULT_DUNNING_SCHEDULE,
};

// Read the operator's dunning policy. Never throws — a missing row / read error
// → DUNNING_DISABLED, so a config problem can never auto-suspend tenants.
export async function getDunningSettings(): Promise<DunningSettings> {
  try {
    const [row] = await db
      .select()
      .from(dunningSettingsTable)
      .where(eq(dunningSettingsTable.id, 1))
      .limit(1);
    if (!row) return DUNNING_DISABLED;
    return {
      enabled: row.enabled,
      schedule: {
        reminder0Days: row.reminder0Days,
        reminder3Days: row.reminder3Days,
        reminder7Days: row.reminder7Days,
        suspendDays: row.suspendDays,
        terminateDays: row.terminateDays,
      },
    };
  } catch (err) {
    logger.error({ err }, "getDunningSettings failed; dunning disabled");
    return DUNNING_DISABLED;
  }
}

export type UpdateDunningInput = {
  enabled?: boolean;
  reminder0Days?: number;
  reminder3Days?: number;
  reminder7Days?: number;
  suspendDays?: number;
  terminateDays?: number;
};

// Atomic upsert of the singleton row. Omitted fields are left unchanged.
export async function updateDunningSettings(
  input: UpdateDunningInput
): Promise<DunningSettings> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.reminder0Days !== undefined) set.reminder0Days = input.reminder0Days;
  if (input.reminder3Days !== undefined) set.reminder3Days = input.reminder3Days;
  if (input.reminder7Days !== undefined) set.reminder7Days = input.reminder7Days;
  if (input.suspendDays !== undefined) set.suspendDays = input.suspendDays;
  if (input.terminateDays !== undefined) set.terminateDays = input.terminateDays;

  await db
    .insert(dunningSettingsTable)
    .values({
      id: 1,
      enabled: input.enabled ?? false,
      reminder0Days: input.reminder0Days ?? DEFAULT_DUNNING_SCHEDULE.reminder0Days,
      reminder3Days: input.reminder3Days ?? DEFAULT_DUNNING_SCHEDULE.reminder3Days,
      reminder7Days: input.reminder7Days ?? DEFAULT_DUNNING_SCHEDULE.reminder7Days,
      suspendDays: input.suspendDays ?? DEFAULT_DUNNING_SCHEDULE.suspendDays,
      terminateDays: input.terminateDays ?? DEFAULT_DUNNING_SCHEDULE.terminateDays,
    })
    .onConflictDoUpdate({ target: dunningSettingsTable.id, set });

  return getDunningSettings();
}
