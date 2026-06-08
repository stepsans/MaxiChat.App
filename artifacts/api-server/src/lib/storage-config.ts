import { eq } from "drizzle-orm";
import { db, storageSettingsTable } from "@workspace/db";
import { logger } from "./logger";

// Read/write the platform storage-enforcement singleton (Billing v2 — FASE C).
// The row is pinned to id=1; until the operator saves one, reads return the
// inert default (enforcement OFF) so uploads behave exactly as before FASE C.

export interface StorageConfig {
  enforcementEnabled: boolean;
  gracePercent: number;
  warnPercent: number;
}

const SINGLETON_ID = 1;

export const STORAGE_DISABLED: StorageConfig = {
  enforcementEnabled: false,
  gracePercent: 0,
  warnPercent: 80,
};

// Resolve the active storage policy. Never throws — on any read error it logs
// and falls back to disabled, so a storage-config problem can never block an
// upload (data-flow safety over enforcement accuracy).
export async function getStorageConfig(): Promise<StorageConfig> {
  try {
    const [row] = await db
      .select()
      .from(storageSettingsTable)
      .where(eq(storageSettingsTable.id, SINGLETON_ID))
      .limit(1);
    if (!row) return { ...STORAGE_DISABLED };
    return {
      enforcementEnabled: row.enforcementEnabled,
      gracePercent: row.gracePercent,
      warnPercent: row.warnPercent,
    };
  } catch (err) {
    logger.error(
      { err },
      "getStorageConfig: failed to read storage settings; defaulting to disabled"
    );
    return { ...STORAGE_DISABLED };
  }
}

export type UpdateStorageConfigInput = {
  enforcementEnabled?: boolean;
  gracePercent?: number;
  warnPercent?: number;
};

// Atomic INSERT…ON CONFLICT(id) DO UPDATE on the singleton: omitted fields are
// left unchanged; a first write seeds the row with the provided values over the
// inert defaults. Returns the resulting config.
export async function updateStorageConfig(
  input: UpdateStorageConfigInput
): Promise<StorageConfig> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enforcementEnabled !== undefined)
    set.enforcementEnabled = input.enforcementEnabled;
  if (input.gracePercent !== undefined) set.gracePercent = input.gracePercent;
  if (input.warnPercent !== undefined) set.warnPercent = input.warnPercent;

  await db
    .insert(storageSettingsTable)
    .values({
      id: SINGLETON_ID,
      enforcementEnabled: input.enforcementEnabled ?? false,
      gracePercent: input.gracePercent ?? 0,
      warnPercent: input.warnPercent ?? 80,
    })
    .onConflictDoUpdate({ target: storageSettingsTable.id, set });

  return getStorageConfig();
}
