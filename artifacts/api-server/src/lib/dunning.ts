import { and, eq, lt, inArray, sql } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceDunningLogTable,
  subscriptionsTable,
  type InvoiceRow,
  type DunningStep,
} from "@workspace/db";
import { logger } from "./logger";
import { getDunningSettings } from "./dunning-config";
import {
  daysOverdue,
  dunningStepsDue,
  dunningDecision,
  type DunningSchedule,
} from "./dunning-build";

// Dunning sweep DB layer (Billing v2 — FASE F). Walks every OVERDUE `open`
// invoice through its escalation ladder, idempotently. The pure state machine
// lives in dunning-build.ts; this module only does DB + subscription effects.
//
// Idempotency: each (invoice_id, step) is logged at most once (unique index), so
// a step's subscription EFFECT (suspend/terminate) is applied exactly once.
// Payment short-circuits the ladder elsewhere: a paid invoice flips to `paid`
// and is no longer selected here; the pay path clears dunning state.

// A db handle that may be the root connection OR an open transaction (mirrors
// subscription-purchase's executor) so the settlement chokepoint can pass its tx.
type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DunningSweepResult = {
  enabled: boolean;
  scannedInvoices: number;
  stepsEmitted: number;
  suspended: number;
  terminated: number;
};

// The subscription effect for the FURTHEST step an invoice qualifies for, applied
// once per step via the log guard. Reminders set dunning metadata but keep the
// tenant fully active; suspend → read-only (status suspended); terminate →
// expired. We never downgrade a manual suspend back to active here.
async function applyStepEffect(
  invoice: InvoiceRow,
  step: DunningStep,
  schedule: DunningSchedule,
  now: Date,
  exec: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<"suspended" | "terminated" | null> {
  const ownerId = invoice.userId;
  if (step === "reminder_0" || step === "reminder_3" || step === "reminder_7") {
    // Mark dunning in progress (first reminder) + record the grace deadline =
    // due_at + suspendDays. Access is unchanged until suspension. Only set
    // dunning_started_at once (coalesce keeps the original start).
    const graceUntil = invoice.dueAt
      ? new Date(invoice.dueAt.getTime() + schedule.suspendDays * 24 * 60 * 60 * 1000)
      : null;
    await exec
      .update(subscriptionsTable)
      .set({
        // COALESCE keeps the original dunning start if one is already set.
        dunningStartedAt: sql`coalesce(${subscriptionsTable.dunningStartedAt}, ${invoice.dueAt ?? now})`,
        graceUntil,
        updatedAt: now,
      })
      .where(eq(subscriptionsTable.userId, ownerId));
    return null;
  }
  if (step === "suspended") {
    await exec
      .update(subscriptionsTable)
      .set({ status: "suspended", updatedAt: now })
      .where(eq(subscriptionsTable.userId, ownerId));
    return "suspended";
  }
  // terminated
  await exec
    .update(subscriptionsTable)
    .set({ status: "expired", updatedAt: now })
    .where(eq(subscriptionsTable.userId, ownerId));
  return "terminated";
}

// Process one overdue invoice: emit every due-but-unlogged step in order, apply
// each effect once. All writes for one invoice run in a single transaction so a
// failure mid-ladder rolls back cleanly (re-tried next sweep).
async function processInvoice(
  invoice: InvoiceRow,
  schedule: DunningSchedule,
  now: Date
): Promise<{ stepsEmitted: number; suspended: number; terminated: number }> {
  if (!invoice.dueAt) return { stepsEmitted: 0, suspended: 0, terminated: 0 };
  const overdue = daysOverdue(invoice.dueAt, now);
  if (overdue < 0) return { stepsEmitted: 0, suspended: 0, terminated: 0 };

  const due = dunningStepsDue(overdue, schedule);
  if (due.length === 0) return { stepsEmitted: 0, suspended: 0, terminated: 0 };

  return db.transaction(async (tx) => {
    // Steps already logged for this invoice (idempotency).
    const existing = await tx
      .select({ step: invoiceDunningLogTable.step })
      .from(invoiceDunningLogTable)
      .where(eq(invoiceDunningLogTable.invoiceId, invoice.id));
    const seen = new Set(existing.map((r) => r.step));

    let stepsEmitted = 0;
    let suspended = 0;
    let terminated = 0;

    for (const step of due) {
      if (seen.has(step)) continue;
      // Insert the log row first (unique guard); skip the effect if a concurrent
      // sweep already claimed this step.
      const inserted = await tx
        .insert(invoiceDunningLogTable)
        .values({ invoiceId: invoice.id, step, channel: "in_app" })
        .onConflictDoNothing({
          target: [invoiceDunningLogTable.invoiceId, invoiceDunningLogTable.step],
        })
        .returning({ id: invoiceDunningLogTable.id });
      if (inserted.length === 0) continue;
      stepsEmitted++;
      const effect = await applyStepEffect(invoice, step, schedule, now, tx);
      if (effect === "suspended") suspended++;
      if (effect === "terminated") terminated++;
    }

    return { stepsEmitted, suspended, terminated };
  });
}

// Run one dunning sweep over all overdue open invoices. No-op (zero counts) when
// dunning is disabled — the default — so this never auto-suspends until the
// operator enables it.
export async function runDunningSweep(now: Date = new Date()): Promise<DunningSweepResult> {
  const settings = await getDunningSettings();
  if (!settings.enabled) {
    return {
      enabled: false,
      scannedInvoices: 0,
      stepsEmitted: 0,
      suspended: 0,
      terminated: 0,
    };
  }

  const overdueInvoices = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.status, "open"),
        lt(invoicesTable.dueAt, now)
      )
    );

  let stepsEmitted = 0;
  let suspended = 0;
  let terminated = 0;
  for (const invoice of overdueInvoices) {
    try {
      const r = await processInvoice(invoice, settings.schedule, now);
      stepsEmitted += r.stepsEmitted;
      suspended += r.suspended;
      terminated += r.terminated;
    } catch (err) {
      logger.error(
        { err, invoiceId: invoice.id },
        "dunning: failed to process invoice; will retry next sweep"
      );
    }
  }

  if (stepsEmitted > 0) {
    logger.info(
      { scanned: overdueInvoices.length, stepsEmitted, suspended, terminated },
      "dunning sweep completed"
    );
  }
  return {
    enabled: true,
    scannedInvoices: overdueInvoices.length,
    stepsEmitted,
    suspended,
    terminated,
  };
}

// Hourly dunning scheduler. Inert until the operator enables dunning
// (runDunningSweep short-circuits on !enabled), so this never auto-suspends a
// prepaid tenant unless explicitly turned on.
let dunningTimer: NodeJS.Timeout | null = null;
export function startDunningScheduler(): void {
  if (dunningTimer) return;
  const HOUR = 60 * 60 * 1000;
  const run = () => {
    runDunningSweep().catch((err) =>
      logger.error({ err }, "dunning scheduler run failed")
    );
  };
  setTimeout(run, 2 * 60 * 1000); // 2 min after boot
  dunningTimer = setInterval(run, HOUR);
}

// Clear dunning state for an owner after an overdue invoice is paid. Restores a
// suspended/expired subscription that was downgraded BY dunning back to active
// (only when the owner still has time on the clock); resets dunning metadata.
// Called from the pay-invoice settlement path. Best-effort, runs in the given
// executor (the settlement transaction).
export async function clearDunningForOwner(
  ownerId: number,
  exec: DbExecutor
): Promise<void> {
  // Only un-suspend if there are no OTHER still-overdue open invoices.
  const others = await exec
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(eq(invoicesTable.userId, ownerId), eq(invoicesTable.status, "open"))
    );
  const stillOverdue = others.length > 0;

  const set: Record<string, unknown> = {
    dunningStartedAt: null,
    graceUntil: null,
    updatedAt: new Date(),
  };
  // Reactivate only when nothing else is open AND the period still has runway.
  if (!stillOverdue) {
    const [sub] = await exec
      .select({
        status: subscriptionsTable.status,
        currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
      })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, ownerId))
      .limit(1);
    const hasRunway =
      sub?.currentPeriodEnd != null &&
      sub.currentPeriodEnd.getTime() > Date.now();
    if (
      hasRunway &&
      (sub?.status === "suspended" || sub?.status === "expired" || sub?.status === "past_due")
    ) {
      set.status = "active";
    }
  }

  await exec
    .update(subscriptionsTable)
    .set(set)
    .where(eq(subscriptionsTable.userId, ownerId));
}

// Mark an open invoice paid (used by the pay-invoice settlement path). Idempotent
// via the status guard.
export async function markInvoicePaid(
  invoiceId: number,
  exec: DbExecutor
): Promise<InvoiceRow | null> {
  const now = new Date();
  const updated = await exec
    .update(invoicesTable)
    .set({ status: "paid", paidAt: now })
    .where(
      and(
        eq(invoicesTable.id, invoiceId),
        inArray(invoicesTable.status, ["open"])
      )
    )
    .returning();
  return updated[0] ?? null;
}
