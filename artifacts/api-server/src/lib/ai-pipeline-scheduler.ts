import { and, eq, lte, sql } from "drizzle-orm";
import { db, aiPipelineCutoffLogsTable } from "@workspace/db";
import { getTzParts, zonedWallClockToUtc } from "./ai-pipeline-time";

// Generate cutoff_log rows for the next 7 days based on the pipeline's
// cutoffTimes, interpreted as wall-clock times in `timeZone`.
export async function scheduleCutoffLogs(
  pipelineId: number,
  ownerUserId: number,
  cutoffTimes: string[],
  timeZone = "Asia/Jakarta"
): Promise<void> {
  const now = new Date();
  // "Today" in the pipeline's timezone — the calendar anchor we add days to.
  const today = getTzParts(now, timeZone);
  const rows: Array<{
    pipelineId: number;
    ownerUserId: number;
    scheduledTime: Date;
    status: string;
  }> = [];

  for (let day = 0; day < 7; day++) {
    for (const timeStr of cutoffTimes) {
      const [hours, minutes] = timeStr.split(":").map(Number);
      // Advance the tz calendar date by `day` (Date normalizes month rollover),
      // then resolve the HH:MM wall-clock in tz to a UTC instant.
      const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + day));
      const scheduled = zonedWallClockToUtc(
        cal.getUTCFullYear(),
        cal.getUTCMonth() + 1,
        cal.getUTCDate(),
        hours ?? 0,
        minutes ?? 0,
        timeZone
      );

      if (scheduled > now) {
        rows.push({ pipelineId, ownerUserId, scheduledTime: scheduled, status: "pending" });
      }
    }
  }

  // Prune FUTURE pending rows whose wall-clock time is no longer a configured
  // cutoff. Without this, editing cutoffTimes (or an older buggy schedule) leaves
  // stale pending rows that still fire at the wrong hour. Only future + pending,
  // so completed/running history and already-due rows are untouched.
  if (cutoffTimes.length > 0) {
    await db.delete(aiPipelineCutoffLogsTable).where(sql`
      ${aiPipelineCutoffLogsTable.pipelineId} = ${pipelineId}
      AND ${aiPipelineCutoffLogsTable.status} = 'pending'
      AND ${aiPipelineCutoffLogsTable.scheduledTime} > NOW()
      AND to_char(${aiPipelineCutoffLogsTable.scheduledTime} AT TIME ZONE ${timeZone}, 'HH24:MI')
          NOT IN (${sql.join(cutoffTimes.map((t) => sql`${t}`), sql`, `)})
    `);
  }

  if (rows.length > 0) {
    // Dedupe on (pipeline_id, scheduled_time) — this path runs at the end of
    // every analysis run, so without an explicit conflict target it would keep
    // inserting duplicate pending logs and trigger a runaway loop.
    await db
      .insert(aiPipelineCutoffLogsTable)
      .values(rows)
      .onConflictDoNothing({
        target: [
          aiPipelineCutoffLogsTable.pipelineId,
          aiPipelineCutoffLogsTable.scheduledTime,
        ],
      });
  }
}

// ─── Scheduler bootstrap ──────────────────────────────────────────────────────

let schedulerStarted = false;

export function startAiPipelineScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Cutoff analysis: every minute. Guard the tick so a transient DB error
  // (e.g. a dropped connection) is logged instead of bubbling up as an
  // unhandledRejection that exits the whole process (crash loop in prod).
  setInterval(() => {
    processPendingCutoffs().catch((err: unknown) => {
      console.error("[ai-pipeline-scheduler] cutoff tick failed:", err);
    });
  }, 60_000);
  // Follow-up sender: every 5 minutes.
  setInterval(() => void processPendingFollowupsWrap(), 5 * 60_000);
}

async function processPendingFollowupsWrap(): Promise<void> {
  try {
    const { processPendingFollowups } = await import("./ai-pipeline-followup");
    await processPendingFollowups();
  } catch (err) {
    console.error("[ai-pipeline-scheduler] follow-up processing failed:", err);
  }
}

// Called every minute by the cron. Picks up pending cutoff logs whose
// scheduled_time <= NOW() and kicks off the analysis (non-blocking).
export async function processPendingCutoffs(): Promise<void> {
  const pending = await db
    .select()
    .from(aiPipelineCutoffLogsTable)
    .where(
      and(
        eq(aiPipelineCutoffLogsTable.status, "pending"),
        lte(aiPipelineCutoffLogsTable.scheduledTime, sql`NOW()`)
      )
    )
    .limit(10);

  for (const log of pending) {
    const { runCutoffAnalysis } = await import("./ai-pipeline-analysis");
    runCutoffAnalysis(log.id).catch((err: unknown) => {
      console.error("[ai-pipeline-scheduler] error for log", log.id, err);
    });
  }
}
