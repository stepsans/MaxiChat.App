// AI Chat Report — auto-schedule runner (Section 13 of the ACR spec).
// Every 5 minutes: find tenant configs whose auto_schedule_next_run_at is
// due, create a job for the period ending today (WIB), run it, then advance
// next_run_at. Each tick is fully guarded — a rejected DB/AI call must never
// surface as an unhandledRejection (that exits the whole process and
// crash-loops the deployment).

import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db, acrConfigsTable, acrJobsTable } from "@workspace/db";
import { logger } from "./logger";
import { autoSchedulePeriod, computeNextRunAt } from "./acr-build";
import { runAcrJob, sendAutoScheduleNotifications } from "./acr-engine";

let started = false;

export function startAcrScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    processDueAutoSchedules().catch((err: unknown) => {
      logger.error({ err }, "[acr-scheduler] tick failed");
    });
  }, 5 * 60_000);
}

export async function processDueAutoSchedules(): Promise<void> {
  const now = new Date();
  const due = await db
    .select()
    .from(acrConfigsTable)
    .where(
      and(
        eq(acrConfigsTable.autoScheduleEnabled, true),
        isNotNull(acrConfigsTable.autoScheduleNextRunAt),
        lte(acrConfigsTable.autoScheduleNextRunAt, now)
      )
    );

  for (const cfg of due) {
    // Advance next_run_at FIRST so a crash mid-run cannot re-trigger the
    // same schedule every 5 minutes.
    const frequency =
      cfg.autoScheduleFrequency === "weekly" || cfg.autoScheduleFrequency === "custom"
        ? cfg.autoScheduleFrequency
        : "monthly";
    const nextRunAt = computeNextRunAt(
      {
        frequency,
        dayOfMonth: cfg.autoScheduleDayOfMonth ?? 1,
        dayOfWeek: cfg.autoScheduleDayOfWeek ?? 1,
        everyDays: cfg.autoScheduleEveryDays ?? 30,
      },
      now
    );
    await db
      .update(acrConfigsTable)
      .set({ autoScheduleNextRunAt: nextRunAt })
      .where(eq(acrConfigsTable.id, cfg.id));

    try {
      const { periodStart, periodEnd } = autoSchedulePeriod(
        frequency,
        cfg.autoScheduleEveryDays ?? 30,
        now
      );
      const [job] = await db
        .insert(acrJobsTable)
        .values({
          ownerUserId: cfg.ownerUserId,
          periodStart,
          periodEnd,
          requestedByUserId: null,
          isAutoScheduled: true,
          status: "pending",
          configSnapshot: snapshotFromConfig(cfg),
        })
        .returning({ id: acrJobsTable.id });

      await runAcrJob(job!.id);
      await sendAutoScheduleNotifications(
        job!.id,
        cfg.ownerUserId,
        cfg.autoScheduleNotifyUserIds ?? []
      );
    } catch (err) {
      logger.error(
        { err, ownerUserId: cfg.ownerUserId },
        "[acr-scheduler] auto job failed"
      );
    }
  }
}

// The immutable per-job snapshot (Section 15.2). Stored camelCase; the
// engine reads it as AcrConfigSnapshot.
export function snapshotFromConfig(
  cfg: typeof acrConfigsTable.$inferSelect
): Record<string, unknown> {
  return {
    weightResponseTime: cfg.weightResponseTime,
    weightLanguageQuality: cfg.weightLanguageQuality,
    weightAnswerQuality: cfg.weightAnswerQuality,
    weightComplaintHandling: cfg.weightComplaintHandling,
    weightMissedChat: cfg.weightMissedChat,
    responseTimeSubweight: cfg.responseTimeSubweight,
    consistencySubweight: cfg.consistencySubweight,
    missedChatSubweight: cfg.missedChatSubweight,
    leadCoverageSubweight: cfg.leadCoverageSubweight,
    slaExcellentMinutes: cfg.slaExcellentMinutes,
    slaGoodMinutes: cfg.slaGoodMinutes,
    slaAcceptableMinutes: cfg.slaAcceptableMinutes,
    slaPoorMinutes: cfg.slaPoorMinutes,
    slaCriticalMinutes: cfg.slaCriticalMinutes,
    gradeAThreshold: cfg.gradeAThreshold,
    gradeBThreshold: cfg.gradeBThreshold,
    gradeCThreshold: cfg.gradeCThreshold,
    gradeDThreshold: cfg.gradeDThreshold,
    allowanceGradeA: cfg.allowanceGradeA,
    allowanceGradeB: cfg.allowanceGradeB,
    allowanceGradeC: cfg.allowanceGradeC,
    allowanceGradeD: cfg.allowanceGradeD,
    allowanceGradeE: cfg.allowanceGradeE,
    complaintHandlingEnabled: cfg.complaintHandlingEnabled,
    includeOwnerInEvaluation: cfg.includeOwnerInEvaluation,
  };
}
