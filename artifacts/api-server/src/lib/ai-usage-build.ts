// Pure, db-free helpers for the AI token-usage summary (Pemakaian Token).
// Kept out of the route handler so node:test can exercise the quota math without
// importing @workspace/db (which connects to Postgres eagerly at import).

export type NotifyLevel = "ok" | "warn80" | "warn20" | "crit5" | "depleted";

// Severity ordering for escalation comparisons (anti-spam emails only fire when
// the level climbs). Higher = more severe.
const NOTIFY_RANK: Record<NotifyLevel, number> = {
  ok: 0,
  warn80: 1,
  warn20: 2,
  crit5: 3,
  depleted: 4,
};

export function notifyLevelRank(level: NotifyLevel): number {
  return NOTIFY_RANK[level] ?? 0;
}

// Percent of the plafon consumed, 0..100. A non-positive limit means "no
// enforced cap" (unprovisioned trial or infinity owner) → 0%, never depleted.
export function computeUsagePercent(tokenLimit: number, tokenUsed: number): number {
  if (tokenLimit <= 0) return 0;
  const pct = Math.round((tokenUsed / tokenLimit) * 100);
  return Math.max(0, Math.min(100, pct));
}

// Bell severity from remaining quota. The founder's thresholds (E1) are
// 80% / 20% / 5% / 0%, where "80% used" and "20% remaining" are the SAME trigger
// — so the warn band is emitted as `warn80` and `warn20` stays a reserved enum
// value. Escalation is severe-first. Uncapped (limit<=0) is always "ok".
export function computeNotifyLevel(tokenLimit: number, tokenUsed: number): NotifyLevel {
  if (tokenLimit <= 0) return "ok";
  const remaining = Math.max(0, tokenLimit - tokenUsed);
  const remainingPct = (remaining / tokenLimit) * 100;
  if (remaining <= 0) return "depleted";
  if (remainingPct <= 5) return "crit5";
  if (remainingPct <= 20) return "warn80";
  return "ok";
}

// Estimate whole days until the quota depletes at the burn rate observed so far
// this period. Null when uncapped, already depleted, or the rate is 0 / there is
// not yet a measurable slice of elapsed time.
export function computeProjectedDaysRemaining(args: {
  tokenLimit: number;
  tokenUsed: number;
  periodStart: Date;
  now: Date;
}): number | null {
  const { tokenLimit, tokenUsed, periodStart, now } = args;
  if (tokenLimit <= 0) return null;
  const remaining = Math.max(0, tokenLimit - tokenUsed);
  if (remaining <= 0) return null;
  const elapsedMs = now.getTime() - periodStart.getTime();
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  if (elapsedDays <= 0 || tokenUsed <= 0) return null;
  const perDay = tokenUsed / elapsedDays;
  if (perDay <= 0) return null;
  return Math.max(0, Math.floor(remaining / perDay));
}
