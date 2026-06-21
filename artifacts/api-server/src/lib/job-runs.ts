import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, jobRunsTable } from "@workspace/db";
import { logger } from "./logger";

// Heartbeat writer for the Dashboard "System Health" strip (spec 2.7 / A.9).
// Every scheduler wraps its work in `runScheduledJob` so a single 'running' row
// is flipped to 'ok'/'failed' — giving the dashboard lastRun + status + error
// for free. Best-effort: a heartbeat write must never break the actual job.

export type JobStatus = "ok" | "failed" | "running";

export async function recordJobRun(params: {
  ownerUserId?: number | null;
  jobName: string;
  status: JobStatus;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(jobRunsTable).values({
      ownerUserId: params.ownerUserId ?? null,
      jobName: params.jobName,
      status: params.status,
      startedAt: params.startedAt ?? null,
      finishedAt: params.finishedAt ?? null,
      errorMessage: params.errorMessage ?? null,
      meta: params.meta ?? null,
    });
  } catch (err) {
    logger.warn({ err, jobName: params.jobName }, "recordJobRun failed");
  }
}

// Wrap a job body so its outcome is always recorded. Returns the body's result
// (or rethrows after recording the failure, so callers keep their own handling).
export async function runScheduledJob<T>(
  jobName: string,
  ownerUserId: number | null,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = new Date();
  try {
    const result = await fn();
    await recordJobRun({
      ownerUserId,
      jobName,
      status: "ok",
      startedAt,
      finishedAt: new Date(),
    });
    return result;
  } catch (err) {
    await recordJobRun({
      ownerUserId,
      jobName,
      status: "failed",
      startedAt,
      finishedAt: new Date(),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// Latest run per jobName for a given owner (and global jobs with null owner),
// for the System Health panel. Returns a map jobName → most-recent row.
export async function latestJobRuns(
  ownerUserId: number,
  jobNames: string[]
): Promise<Record<string, { status: string; finishedAt: Date | null; errorMessage: string | null }>> {
  if (jobNames.length === 0) return {};
  const rows = await db
    .select({
      jobName: jobRunsTable.jobName,
      status: jobRunsTable.status,
      finishedAt: jobRunsTable.finishedAt,
      errorMessage: jobRunsTable.errorMessage,
      createdAt: jobRunsTable.createdAt,
    })
    .from(jobRunsTable)
    .where(
      and(
        inArray(jobRunsTable.jobName, jobNames),
        sql`(${jobRunsTable.ownerUserId} = ${ownerUserId} OR ${jobRunsTable.ownerUserId} IS NULL)`
      )
    )
    .orderBy(desc(jobRunsTable.createdAt))
    .limit(200);

  const out: Record<string, { status: string; finishedAt: Date | null; errorMessage: string | null }> = {};
  for (const r of rows) {
    if (!out[r.jobName]) {
      out[r.jobName] = { status: r.status, finishedAt: r.finishedAt, errorMessage: r.errorMessage };
    }
  }
  return out;
}
