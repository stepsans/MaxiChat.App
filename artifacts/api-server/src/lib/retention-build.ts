// Pure, db-free retention math (Billing v2 — FASE E). Kept free of any
// @workspace/db import so it stays unit-testable under the node:test runner.
//
// A tenant chooses a per-class retention age (days), bounded by the active
// plan's cap (`plans.retentionLimitDays`): a tenant can keep data SHORTER than
// the plan cap, never longer. The purger deletes rows/objects older than the
// EFFECTIVE retention. A null on either side means "unlimited" for that side.

// The four retention classes the purger manages.
export type RetentionClass = "chat" | "media" | "log" | "analytics";

// The tenant's chosen per-class ages (days); null = unlimited (keep forever).
export type RetentionChoice = {
  chatDays: number | null;
  mediaDays: number | null;
  logDays: number | null;
  analyticsDays: number | null;
};

// Effective retention days for one class = min(chosen, planCap), treating null
// as +Infinity (unlimited). Returns null when BOTH are unlimited → never purge
// that class. A non-positive value is treated as unlimited too (defensive: a 0
// would otherwise purge everything instantly).
export function effectiveRetentionDays(
  chosenDays: number | null,
  planCapDays: number | null
): number | null {
  const chosen = chosenDays != null && chosenDays > 0 ? chosenDays : Infinity;
  const cap = planCapDays != null && planCapDays > 0 ? planCapDays : Infinity;
  const eff = Math.min(chosen, cap);
  return Number.isFinite(eff) ? eff : null;
}

// The cutoff instant: rows/objects with created_at STRICTLY BEFORE this are
// eligible for deletion. Null retention → null cutoff (purge nothing).
export function retentionCutoff(
  effectiveDays: number | null,
  now: Date
): Date | null {
  if (effectiveDays == null) return null;
  return new Date(now.getTime() - effectiveDays * 24 * 60 * 60 * 1000);
}

// Resolve the cutoff per class from a choice + plan cap, in one call. Each value
// is the cutoff Date or null (don't purge). The plan cap applies uniformly to
// every class (it's a single `plans.retentionLimitDays`).
export function retentionCutoffs(
  choice: RetentionChoice,
  planCapDays: number | null,
  now: Date
): Record<RetentionClass, Date | null> {
  return {
    chat: retentionCutoff(
      effectiveRetentionDays(choice.chatDays, planCapDays),
      now
    ),
    media: retentionCutoff(
      effectiveRetentionDays(choice.mediaDays, planCapDays),
      now
    ),
    log: retentionCutoff(
      effectiveRetentionDays(choice.logDays, planCapDays),
      now
    ),
    analytics: retentionCutoff(
      effectiveRetentionDays(choice.analyticsDays, planCapDays),
      now
    ),
  };
}
