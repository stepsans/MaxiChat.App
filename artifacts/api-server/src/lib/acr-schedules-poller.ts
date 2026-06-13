import { and, eq, lte } from "drizzle-orm";
import { db, acrSchedulesTable, acrJobsTable, acrConfigsTable } from "@workspace/db";
import { computeScheduleNextRun, schedulePeriod, type ScheduleFrequency } from "./acr-build";
import { snapshotFromConfig } from "./acr-scheduler";
import {
  runAcrJob,
  sendAutoScheduleNotifications,
  generateAndStoreJobPdf,
} from "./acr-engine";
import { logger } from "./logger";

// Recurring AI Chat Report scheduler (Bagian II). Every 60s it finds active
// acr_schedules whose next_run_at has passed, creates a scheduled job, runs it,
// and notifies subscribers. Supersedes the single-per-tenant acr-scheduler.ts.
//
// Concurrency: in-memory `inFlight` guard (single instance, like the other
// pollers in this codebase). Per schedule: advance next_run_at FIRST so a crash
// mid-run can't re-trigger every minute; a catch-up guard skips a duplicate job
// for the same schedule + period_end.

let schedulerStarted = false;
let inFlight = false;

async function getConfig(ownerUserId: number) {
  const existing = await db.query.acrConfigsTable.findFirst({
    where: eq(acrConfigsTable.ownerUserId, ownerUserId),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(acrConfigsTable)
    .values({ ownerUserId })
    .onConflictDoNothing({ target: acrConfigsTable.ownerUserId })
    .returning();
  if (created) return created;
  return (await db.query.acrConfigsTable.findFirst({
    where: eq(acrConfigsTable.ownerUserId, ownerUserId),
  }))!;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(acrSchedulesTable)
      .where(and(eq(acrSchedulesTable.isActive, true), lte(acrSchedulesTable.nextRunAt, now)));

    for (const sched of due) {
      try {
        // Advance next_run_at FIRST (anti re-trigger on crash).
        const freq = sched.frequency as ScheduleFrequency;
        const nextRunAt = computeScheduleNextRun(
          {
            frequency: freq,
            dayOfWeek: sched.dayOfWeek,
            dayOfMonth: sched.dayOfMonth,
            cutoffHour: sched.cutoffHour,
            cutoffMinute: sched.cutoffMinute,
          },
          now
        );
        await db
          .update(acrSchedulesTable)
          .set({ nextRunAt })
          .where(eq(acrSchedulesTable.id, sched.id));

        const { periodStart, periodEnd } = schedulePeriod(freq, now);

        // Catch-up idempotency: don't double-create for the same period.
        const dup = await db.query.acrJobsTable.findFirst({
          where: and(
            eq(acrJobsTable.scheduleId, sched.id),
            eq(acrJobsTable.periodEnd, periodEnd)
          ),
        });
        if (dup) continue;

        const cfg = await getConfig(sched.ownerUserId);
        const [job] = await db
          .insert(acrJobsTable)
          .values({
            ownerUserId: sched.ownerUserId,
            periodStart,
            periodEnd,
            requestedByUserId: null,
            isAutoScheduled: true,
            jobType: "scheduled",
            scheduleId: sched.id,
            agentUserIds: sched.agentUserIds,
            status: "pending",
            configSnapshot: snapshotFromConfig(cfg),
          })
          .returning({ id: acrJobsTable.id });

        await runAcrJob(job!.id);
        if (sched.generatePdf) {
          try {
            await generateAndStoreJobPdf(job!.id);
          } catch (err) {
            logger.error({ err, jobId: job!.id }, "[acr-schedules] PDF auto-gen failed");
          }
        }
        await sendAutoScheduleNotifications(
          job!.id,
          sched.ownerUserId,
          sched.notifyUserIds ?? []
        );
        await db
          .update(acrSchedulesTable)
          .set({ lastRunAt: new Date(), lastRunJobId: job!.id, totalRuns: sched.totalRuns + 1 })
          .where(eq(acrSchedulesTable.id, sched.id));
        logger.info({ scheduleId: sched.id, jobId: job!.id }, "[acr-schedules] ran scheduled report");
      } catch (err) {
        logger.error({ err, scheduleId: sched.id }, "[acr-schedules] schedule run failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "acr-schedules poller tick failed");
  } finally {
    inFlight = false;
  }
}

export function startAcrSchedulesPoller(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // First tick after 60s to let the server fully boot.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60_000);
  }, 60_000);
  logger.info("acr-schedules poller started");
}
