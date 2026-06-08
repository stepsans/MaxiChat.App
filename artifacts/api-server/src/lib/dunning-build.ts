// Pure, db-free dunning state machine (Billing v2 — FASE F). Kept free of any
// @workspace/db import so it stays unit-testable under the node:test runner.
//
// When a `monthly_close` invoice is issued `open` with a `due_at`, the daily
// sweep walks it through escalating steps based on how many days it has been
// overdue. Reminders (0/3/7) keep the tenant fully active; at +14 days the
// tenant goes read-only (suspended); at +30 days the subscription terminates
// (expired → eligible for retention purge). Any payment short-circuits the
// whole ladder (handled in the DB layer, not here).
import type { DunningStep } from "@workspace/db";

// Operator-tunable dunning schedule (days AFTER due_at). Defaults encode the
// reminder→grace→suspend→terminate ladder described above.
export type DunningSchedule = {
  reminder0Days: number; // first notice (== due date)
  reminder3Days: number;
  reminder7Days: number;
  suspendDays: number; // read-only from here
  terminateDays: number; // subscription terminated from here
};

export const DEFAULT_DUNNING_SCHEDULE: DunningSchedule = {
  reminder0Days: 0,
  reminder3Days: 3,
  reminder7Days: 7,
  suspendDays: 14,
  terminateDays: 30,
};

// Whole days `now` is past `dueAt` (floor; negative before due). Pure date math.
export function daysOverdue(dueAt: Date, now: Date): number {
  const ms = now.getTime() - dueAt.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// The subscription effect a dunning step implies. `none` = keep full access
// (reminders), `suspend` = read-only (status suspended), `terminate` = expired.
export type DunningEffect = "none" | "suspend" | "terminate";

export type DunningDecision = {
  // The furthest step the invoice now qualifies for given days overdue.
  step: DunningStep;
  effect: DunningEffect;
};

// Given how overdue an invoice is, return the furthest step it now qualifies
// for (and the subscription effect). Returns null when not yet due (overdue<0)
// — nothing to do. The sweep is responsible for not re-emitting an already-
// logged step (UNIQUE invoice_id+step), so this always returns the CURRENT
// max step; earlier un-emitted steps are caught up by the sweep.
export function dunningDecision(
  overdueDays: number,
  schedule: DunningSchedule = DEFAULT_DUNNING_SCHEDULE
): DunningDecision | null {
  if (overdueDays < schedule.reminder0Days) return null;
  if (overdueDays >= schedule.terminateDays) {
    return { step: "terminated", effect: "terminate" };
  }
  if (overdueDays >= schedule.suspendDays) {
    return { step: "suspended", effect: "suspend" };
  }
  if (overdueDays >= schedule.reminder7Days) {
    return { step: "reminder_7", effect: "none" };
  }
  if (overdueDays >= schedule.reminder3Days) {
    return { step: "reminder_3", effect: "none" };
  }
  return { step: "reminder_0", effect: "none" };
}

// Every step at or below the current overdue level, oldest-first. The sweep
// emits each that isn't already logged so a tenant that was offline for a week
// gets the catch-up reminders in order (idempotent via the unique index).
export function dunningStepsDue(
  overdueDays: number,
  schedule: DunningSchedule = DEFAULT_DUNNING_SCHEDULE
): DunningStep[] {
  const all: Array<{ step: DunningStep; at: number }> = [
    { step: "reminder_0", at: schedule.reminder0Days },
    { step: "reminder_3", at: schedule.reminder3Days },
    { step: "reminder_7", at: schedule.reminder7Days },
    { step: "suspended", at: schedule.suspendDays },
    { step: "terminated", at: schedule.terminateDays },
  ];
  return all.filter((s) => overdueDays >= s.at).map((s) => s.step);
}

// Compute due_at for a freshly-issued monthly_close invoice: issue date + N
// days of payment terms.
export function dueDateForInvoice(issuedAt: Date, termDays: number): Date {
  return new Date(issuedAt.getTime() + Math.max(0, termDays) * 24 * 60 * 60 * 1000);
}
