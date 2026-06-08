import { eq } from "drizzle-orm";
import { db, overageRatesTable } from "@workspace/db";
import { logger } from "./logger";
import { OVERAGE_DISABLED, type OverageRates } from "./overage-build";

// Read/write the platform OVERAGE-rates singleton (Billing v2 — Overage engine).
// Pinned to id=1; until the operator saves one, reads return the inert default
// (overage off) so the monthly close behaves exactly as before.

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const SINGLETON_ID = 1;

// Resolve the active overage tariffs. Never throws — on any read error it logs
// and falls back to disabled, so an overage-config problem can never block the
// monthly close (revenue safety over overage accuracy).
export async function getOverageRates(
  exec: DbExecutor = db
): Promise<OverageRates> {
  try {
    const [row] = await exec
      .select()
      .from(overageRatesTable)
      .where(eq(overageRatesTable.id, SINGLETON_ID))
      .limit(1);
    if (!row) return { ...OVERAGE_DISABLED };
    return {
      enabled: row.enabled,
      tokenUnit: row.tokenUnit,
      tokenUnitPriceIdr: row.tokenUnitPriceIdr,
      storageGbDayPriceIdr: row.storageGbDayPriceIdr,
    };
  } catch (err) {
    logger.error(
      { err },
      "getOverageRates: failed to read overage rates; defaulting to disabled"
    );
    return { ...OVERAGE_DISABLED };
  }
}

export type UpdateOverageRatesInput = {
  enabled?: boolean;
  tokenUnit?: number;
  tokenUnitPriceIdr?: number;
  storageGbDayPriceIdr?: number;
};

// Atomic INSERT…ON CONFLICT(id) DO UPDATE on the singleton: omitted fields are
// left unchanged; a first write seeds the row with the provided values over the
// inert defaults. Returns the resulting config.
export async function updateOverageRates(
  input: UpdateOverageRatesInput
): Promise<OverageRates> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.tokenUnit !== undefined) set.tokenUnit = input.tokenUnit;
  if (input.tokenUnitPriceIdr !== undefined)
    set.tokenUnitPriceIdr = input.tokenUnitPriceIdr;
  if (input.storageGbDayPriceIdr !== undefined)
    set.storageGbDayPriceIdr = input.storageGbDayPriceIdr;

  await db
    .insert(overageRatesTable)
    .values({
      id: SINGLETON_ID,
      enabled: input.enabled ?? false,
      tokenUnit: input.tokenUnit ?? 100,
      tokenUnitPriceIdr: input.tokenUnitPriceIdr ?? 0,
      storageGbDayPriceIdr: input.storageGbDayPriceIdr ?? 0,
    })
    .onConflictDoUpdate({ target: overageRatesTable.id, set });

  return getOverageRates();
}
