// Pure, db-free storage-quota math (Billing v2 — FASE C). Kept free of any DB
// import so it is unit-testable under the api-server node:test runner
// (@workspace/db connects eagerly, so testable logic must not import it).
//
// Two concerns:
//   - monitoring: how full is the tenant (percent + ok/warn/over level)?
//   - enforcement: is one more upload of N bytes allowed?
// Both honor a "hard limit" = the plafon plus an optional grace percent of
// slack above it. A non-positive limit means "not provisioned / unlimited" and
// is treated as never-full + always-writable (so enabling enforcement can never
// block a tenant who has no plan/plafon yet).

export type StorageLevel = "ok" | "warn" | "over";

export interface StorageStatusInput {
  usedBytes: number;
  limitBytes: number;
  // Display-only "near limit" threshold (percent of the plafon).
  warnPercent: number;
  // Slack above the plafon before enforcement blocks (percent of the plafon).
  gracePercent: number;
}

export interface StorageStatus {
  usedBytes: number;
  limitBytes: number;
  // limit + grace slack; the point at which enforcement would block.
  hardLimitBytes: number;
  // Used / limit as a whole-number percent (0 when no limit configured).
  percent: number;
  level: StorageLevel;
}

// Whole-number percent of used vs limit. Returns 0 for a non-positive limit.
export function storagePercent(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0;
  return Math.round((usedBytes / limitBytes) * 100);
}

// The enforcement ceiling: the plafon plus `gracePercent` of slack (floored to
// whole bytes). Grace is clamped to >= 0 so a negative config can't shrink it.
export function hardLimitBytes(limitBytes: number, gracePercent: number): number {
  if (limitBytes <= 0) return 0;
  const grace = Math.max(0, gracePercent);
  return limitBytes + Math.floor((limitBytes * grace) / 100);
}

// Can the tenant store `incomingBytes` more? A non-positive limit is always
// writable (unprovisioned / unlimited). Otherwise used + incoming must stay at
// or below the hard limit (plafon + grace).
export function isStorageWritable(
  usedBytes: number,
  incomingBytes: number,
  limitBytes: number,
  gracePercent: number
): boolean {
  if (limitBytes <= 0) return true;
  return usedBytes + incomingBytes <= hardLimitBytes(limitBytes, gracePercent);
}

// Monitoring snapshot: percent + ok/warn/over level. `over` means already past
// the hard limit; `warn` means at/above warnPercent of the plafon but not over.
export function computeStorageStatus(input: StorageStatusInput): StorageStatus {
  const { usedBytes, limitBytes, warnPercent, gracePercent } = input;
  const hard = hardLimitBytes(limitBytes, gracePercent);
  const percent = storagePercent(usedBytes, limitBytes);
  let level: StorageLevel = "ok";
  if (limitBytes > 0) {
    if (usedBytes > hard) level = "over";
    else if (percent >= warnPercent) level = "warn";
  }
  return { usedBytes, limitBytes, hardLimitBytes: hard, percent, level };
}
