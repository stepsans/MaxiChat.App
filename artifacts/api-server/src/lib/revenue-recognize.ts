// Pure, db-free revenue-recognition math (Billing v2 — FASE H). Kept free of
// any @workspace/db import so it stays unit-testable under the node:test runner.
//
// SaaS accounting separates BILLINGS (cash collected) from RECOGNIZED REVENUE
// (earned over the service period). An annual plan paid up front is recognized
// per-day across coversFrom..coversTo, not all at once — so MRR/ARR don't spike
// on payment. Point-in-time items (usage/booster consumption) are recognized in
// full on their issue date. All money is whole Rupiah.

// One invoice line as needed for recognition. `coversFrom`/`coversTo` define the
// service window for over-time items; null = recognize immediately (issue date).
export type RecognizableLine = {
  amountIdr: number;
  lineType: string;
  coversFrom: Date | null;
  coversTo: Date | null;
  issuedAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Inclusive whole-day count of a service window (>= 1).
export function windowDays(from: Date, to: Date): number {
  const d = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  return Math.max(1, d);
}

// Daily recognized amount for an over-time line (amount / windowDays). Returns
// the line amount for an immediate (no-window) line — it's recognized in one
// day. Whole Rupiah (floor); the rounding remainder is recognized on the last
// day via recognizedInPeriod's clamp, so the series always sums to the total.
export function dailyRecognition(line: RecognizableLine): number {
  if (!line.coversFrom || !line.coversTo) return line.amountIdr;
  const days = windowDays(line.coversFrom, line.coversTo);
  return Math.floor(line.amountIdr / days);
}

// Revenue recognized from a single line within [periodStart, periodEnd)
// (half-open). Over-time lines accrue per overlapping day; immediate lines are
// recognized in full if their issue date falls in the period. Never exceeds the
// line amount (rounding remainder included on the final overlapping day).
export function recognizedFromLine(
  line: RecognizableLine,
  periodStart: Date,
  periodEnd: Date
): number {
  // Immediate (point-in-time) recognition.
  if (!line.coversFrom || !line.coversTo) {
    const t = line.issuedAt.getTime();
    return t >= periodStart.getTime() && t < periodEnd.getTime()
      ? line.amountIdr
      : 0;
  }
  const from = line.coversFrom.getTime();
  const to = line.coversTo.getTime();
  const total = windowDays(line.coversFrom, line.coversTo);
  const perDay = Math.floor(line.amountIdr / total);

  const overlapStart = Math.max(from, periodStart.getTime());
  const overlapEnd = Math.min(to, periodEnd.getTime());
  if (overlapEnd <= overlapStart) return 0;
  const overlapDays = Math.round((overlapEnd - overlapStart) / DAY_MS);
  if (overlapDays <= 0) return 0;

  // If this period covers the tail of the window, include the rounding
  // remainder so the full line is recognized exactly once across all periods.
  const coversTail = overlapEnd >= to;
  const base = perDay * overlapDays;
  if (coversTail) {
    const recognizedBefore = perDay * (total - overlapDays);
    return line.amountIdr - recognizedBefore;
  }
  return base;
}

// Total recognized revenue from many lines within a period.
export function recognizedInPeriod(
  lines: RecognizableLine[],
  periodStart: Date,
  periodEnd: Date
): number {
  return lines.reduce(
    (sum, l) => sum + recognizedFromLine(l, periodStart, periodEnd),
    0
  );
}

// Normalize a subscription line's full amount to a MONTHLY figure for MRR.
// Over-time lines: amount / windowDays × 30. Immediate lines contribute 0 to
// MRR (they're one-off, not recurring). Whole Rupiah.
export function monthlyNormalized(line: RecognizableLine): number {
  if (!line.coversFrom || !line.coversTo) return 0;
  const days = windowDays(line.coversFrom, line.coversTo);
  return Math.round((line.amountIdr / days) * 30);
}
