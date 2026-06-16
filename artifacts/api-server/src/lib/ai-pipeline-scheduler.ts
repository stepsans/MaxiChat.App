import { and, eq, lte, sql } from "drizzle-orm";
import { db, aiPipelineCutoffLogsTable } from "@workspace/db";

// Generate cutoff_log rows for the next 7 days based on the pipeline's cutoffTimes.
export async function scheduleCutoffLogs(
  pipelineId: number,
  ownerUserId: number,
  cutoffTimes: string[]
): Promise<void> {
  const now = new Date();
  const rows: Array<{
    pipelineId: number;
    ownerUserId: number;
    scheduledTime: Date;
    status: string;
  }> = [];

  for (let day = 0; day < 7; day++) {
    for (const timeStr of cutoffTimes) {
      const [hours, minutes] = timeStr.split(":").map(Number);
      const scheduled = new Date(now);
      scheduled.setDate(scheduled.getDate() + day);
      scheduled.setHours(hours, minutes, 0, 0);

      if (scheduled > now) {
        rows.push({ pipelineId, ownerUserId, scheduledTime: scheduled, status: "pending" });
      }
    }
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
