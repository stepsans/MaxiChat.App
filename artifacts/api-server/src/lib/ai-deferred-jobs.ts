import { and, eq, sql } from "drizzle-orm";
import { db, aiDeferredJobsTable } from "@workspace/db";
import { logger } from "./logger";
import { isOwnerTokenBlocked } from "./ai-quota";

export type DeferredJobType =
  | "pipeline_cutoff"
  | "pipeline_followup"
  | "sales_followup"
  | "acr_job";

// Record (or re-open) a deferred job when a background AI task hits the token
// hard-block (spec C2). Idempotent on (owner, type, ref): a re-block just bumps
// blockedAt and re-opens a previously completed row. Best-effort — never throws,
// so deferral bookkeeping can't break the caller's graceful skip.
export async function recordDeferredJob(args: {
  ownerUserId: number;
  jobType: DeferredJobType;
  jobRef: string | number;
  now?: Date;
}): Promise<void> {
  try {
    const now = args.now ?? new Date();
    await db
      .insert(aiDeferredJobsTable)
      .values({
        ownerUserId: args.ownerUserId,
        jobType: args.jobType,
        jobRef: String(args.jobRef),
        status: "deferred",
        blockedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          aiDeferredJobsTable.ownerUserId,
          aiDeferredJobsTable.jobType,
          aiDeferredJobsTable.jobRef,
        ],
        set: {
          status: "deferred",
          blockedAt: now,
          resumedAt: null,
          updatedAt: now,
        },
      });
  } catch (err) {
    logger.error({ err, ...args }, "recordDeferredJob failed");
  }
}

// Owner ids that currently have at least one open (deferred) job.
async function ownersWithDeferredJobs(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ ownerUserId: aiDeferredJobsTable.ownerUserId })
    .from(aiDeferredJobsTable)
    .where(eq(aiDeferredJobsTable.status, "deferred"));
  return rows.map((r) => r.ownerUserId);
}

// Mark an owner's open deferred jobs as resumed. The actual re-processing +
// rule re-validation is done by each job's own scheduler/poller, which re-runs
// the still-pending source item (cutoff log, scheduled follow-up, acr job) the
// moment quota is back — exactly the normal path, so no stale send slips through
// and idempotency watermarks prevent a double-run. This stamp is the audit
// record that the hold has been released.
async function markOwnerResumed(ownerUserId: number, now: Date): Promise<number> {
  const res = await db
    .update(aiDeferredJobsTable)
    .set({ status: "completed", resumedAt: now, updatedAt: now })
    .where(
      and(
        eq(aiDeferredJobsTable.ownerUserId, ownerUserId),
        eq(aiDeferredJobsTable.status, "deferred")
      )
    );
  return res.rowCount ?? 0;
}

// One sweep: for every owner whose quota is no longer exhausted, release their
// deferred jobs and re-dispatch them. Release happens BEFORE dispatch so that if
// a re-run blocks again, the processor reopens its own row (recordDeferredJob)
// without racing this stamp.
export async function runDeferredResumeSweep(now: Date = new Date()): Promise<void> {
  const owners = await ownersWithDeferredJobs();
  if (owners.length === 0) return;

  const acrJobRefs: string[] = [];
  let anyPipeline = false;

  for (const ownerUserId of owners) {
    if (await isOwnerTokenBlocked(ownerUserId, now)) continue; // still blocked

    // Capture what's queued for this owner BEFORE releasing the rows.
    const rows = await db
      .select({
        jobType: aiDeferredJobsTable.jobType,
        jobRef: aiDeferredJobsTable.jobRef,
      })
      .from(aiDeferredJobsTable)
      .where(
        and(
          eq(aiDeferredJobsTable.ownerUserId, ownerUserId),
          eq(aiDeferredJobsTable.status, "deferred")
        )
      );
    if (rows.length === 0) continue;

    await markOwnerResumed(ownerUserId, now);
    logger.info({ ownerUserId, released: rows.length }, "deferred AI jobs resumed");

    for (const r of rows) {
      if (r.jobType === "acr_job") acrJobRefs.push(r.jobRef);
      else anyPipeline = true; // pipeline_cutoff / pipeline_followup / sales_followup
    }
  }

  // acr jobs have no pending-poller — re-run each explicitly (re-validates; will
  // re-defer itself if quota lapses again mid-run).
  if (acrJobRefs.length > 0) {
    try {
      const { runAcrJob } = await import("./acr-engine");
      for (const jobId of acrJobRefs) {
        await runAcrJob(jobId).catch((err: unknown) =>
          logger.error({ err, jobId }, "deferred acr resume failed")
        );
      }
    } catch (err) {
      logger.error({ err }, "deferred acr resume import failed");
    }
  }

  // Pipeline cutoff/follow-up source items were left pending/due — nudge the
  // processors once so they re-run promptly (both re-validate every item).
  if (anyPipeline) {
    try {
      const [{ processPendingCutoffs }, { processPendingFollowups }] =
        await Promise.all([
          import("./ai-pipeline-scheduler"),
          import("./ai-pipeline-followup"),
        ]);
      await processPendingCutoffs();
      await processPendingFollowups();
    } catch (err) {
      logger.error({ err }, "deferred resume nudge failed");
    }
  }
}

let resumeTimer: NodeJS.Timeout | null = null;

export function startDeferredResumeScheduler(): void {
  if (resumeTimer) return;
  const FIVE_MIN = 5 * 60 * 1000;
  const run = () => {
    runDeferredResumeSweep().catch((err) =>
      logger.error({ err }, "deferred resume sweep failed")
    );
  };
  // First run 7 min after boot (after the booster/other startup work settles).
  setTimeout(run, 7 * 60 * 1000);
  resumeTimer = setInterval(run, FIVE_MIN);
}
