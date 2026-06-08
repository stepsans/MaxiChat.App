import { eq } from "drizzle-orm";
import { db, taxSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { TAX_DISABLED, type TaxConfig } from "./invoice-build";

// Read/write the platform tax (PPN) singleton (Billing v2 — FASE G). The row is
// pinned to id=1; until the operator saves one, reads return the inert default
// (tax off) so invoices behave exactly as before FASE G.

// A db handle that may be the root connection OR an open transaction, so tax
// can be read inside the settlement transaction that creates payment invoices.
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const SINGLETON_ID = 1;

// Resolve the active tax policy. Never throws — on any read error it logs and
// falls back to disabled, so a tax-config problem can never block settlement or
// the monthly close (revenue safety over tax accuracy).
export async function getTaxConfig(exec: DbExecutor = db): Promise<TaxConfig> {
  try {
    const [row] = await exec
      .select()
      .from(taxSettingsTable)
      .where(eq(taxSettingsTable.id, SINGLETON_ID))
      .limit(1);
    if (!row) return { ...TAX_DISABLED };
    return {
      enabled: row.enabled,
      rateBps: row.rateBps,
      inclusive: row.inclusive,
      label: row.label,
    };
  } catch (err) {
    logger.error(
      { err },
      "getTaxConfig: failed to read tax settings; defaulting to disabled"
    );
    return { ...TAX_DISABLED };
  }
}

export type UpdateTaxConfigInput = {
  enabled?: boolean;
  rateBps?: number;
  inclusive?: boolean;
  label?: string;
};

// Atomic INSERT…ON CONFLICT(id) DO UPDATE on the singleton: omitted fields are
// left unchanged; a first write seeds the row with the provided values over the
// inert defaults. Returns the resulting (masked-free) config.
export async function updateTaxConfig(
  input: UpdateTaxConfigInput
): Promise<TaxConfig> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.rateBps !== undefined) set.rateBps = input.rateBps;
  if (input.inclusive !== undefined) set.inclusive = input.inclusive;
  if (input.label !== undefined) set.label = input.label.trim() || "PPN";

  await db
    .insert(taxSettingsTable)
    .values({
      id: SINGLETON_ID,
      enabled: input.enabled ?? false,
      rateBps: input.rateBps ?? 0,
      inclusive: input.inclusive ?? true,
      label: input.label?.trim() || "PPN",
    })
    .onConflictDoUpdate({ target: taxSettingsTable.id, set });

  return getTaxConfig();
}
