// Pure, db-free overage math (Billing v2 — Overage engine). Kept free of any
// @workspace/db import so it stays unit-testable under the node:test runner.
// Only TYPE imports are used (erased at runtime). All money is whole Rupiah.
//
// Overage = metered usage ABOVE the prepaid `tenant_quota` plafon, billed as
// `usage` invoice lines on the monthly close. Two components leak real COGS:
//   - AI tokens : charged per whole token block over the token plafon.
//   - Storage   : charged per GB-DAY of average-daily storage over the plafon.
import type { InvoiceLineInput } from "./invoice-build";

// The operator's overage tariffs (mirrors overage_rates; plain type so this
// module is db-free). Disabled / zero prices → no overage is ever charged.
export type OverageRates = {
  enabled: boolean;
  tokenUnit: number; // block size, e.g. 100 tokens
  tokenUnitPriceIdr: number;
  storageGbDayPriceIdr: number;
};

export const OVERAGE_DISABLED: OverageRates = {
  enabled: false,
  tokenUnit: 100,
  tokenUnitPriceIdr: 0,
  storageGbDayPriceIdr: 0,
};

// The usage measured for one owner over the billing period, plus the plafon it
// is compared against. `tokenUsed`/`tokenLimit` are token counts;
// `avgStorageBytes` is the AVERAGE-daily Object-Storage footprint over the
// period (mean of the daily snapshots), `storageLimitBytes` the plafon.
export type OverageUsage = {
  tokenUsed: number;
  tokenLimit: number;
  avgStorageBytes: number;
  storageLimitBytes: number;
  periodDays: number;
};

const BYTES_PER_GB = 1024 * 1024 * 1024;

// Token overage line: floor((used - limit) / tokenUnit) whole blocks × price.
// Floor (never round up) so a partial block is never charged — we can only
// under-bill a fractional remainder, never over-bill. Returns null when there
// is no chargeable overage.
export function computeTokenOverageLine(
  usage: Pick<OverageUsage, "tokenUsed" | "tokenLimit">,
  rates: OverageRates
): InvoiceLineInput | null {
  if (!rates.enabled) return null;
  if (rates.tokenUnit <= 0 || rates.tokenUnitPriceIdr <= 0) return null;
  const over = Math.max(0, Math.floor(usage.tokenUsed) - Math.floor(usage.tokenLimit));
  if (over <= 0) return null;
  const blocks = Math.floor(over / rates.tokenUnit);
  if (blocks < 1) return null;
  return {
    lineType: "usage",
    refId: null,
    description: `Kelebihan token AI (${blocks} × ${rates.tokenUnit} token)`,
    quantity: blocks,
    unitPriceIdr: rates.tokenUnitPriceIdr,
    amountIdr: blocks * rates.tokenUnitPriceIdr,
  };
}

// Storage overage line: GB-days over the plafon × price/GB-day. GB-days =
// (avgBytesOver / bytesPerGb) × periodDays, rounded to a whole GB-day count
// (round, since storage is a continuous measure). Returns null when nothing is
// chargeable.
export function computeStorageOverageLine(
  usage: Pick<OverageUsage, "avgStorageBytes" | "storageLimitBytes" | "periodDays">,
  rates: OverageRates
): InvoiceLineInput | null {
  if (!rates.enabled) return null;
  if (rates.storageGbDayPriceIdr <= 0) return null;
  if (usage.periodDays <= 0) return null;
  const overBytes = Math.max(0, usage.avgStorageBytes - usage.storageLimitBytes);
  if (overBytes <= 0) return null;
  const overGb = overBytes / BYTES_PER_GB;
  const gbDays = Math.round(overGb * usage.periodDays);
  if (gbDays < 1) return null;
  return {
    lineType: "usage",
    refId: null,
    description: `Kelebihan penyimpanan (${gbDays} GB-hari)`,
    quantity: gbDays,
    unitPriceIdr: rates.storageGbDayPriceIdr,
    amountIdr: gbDays * rates.storageGbDayPriceIdr,
  };
}

// Build every overage `usage` line for one owner. Empty array when overage is
// disabled or nothing exceeds the plafon (the common case → monthly_close is
// byte-for-byte unchanged).
export function computeOverageLines(
  usage: OverageUsage,
  rates: OverageRates
): InvoiceLineInput[] {
  const lines: InvoiceLineInput[] = [];
  const token = computeTokenOverageLine(usage, rates);
  if (token) lines.push(token);
  const storage = computeStorageOverageLine(usage, rates);
  if (storage) lines.push(storage);
  return lines;
}
