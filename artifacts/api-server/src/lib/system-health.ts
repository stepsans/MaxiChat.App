import { and, desc, eq } from "drizzle-orm";
import {
  db,
  channelsTable,
  aiPipelineCutoffLogsTable,
} from "@workspace/db";
import { getEnginesView } from "./platform-ai-engine";
import { getOwnerTokenQuota } from "./ai-quota";
import { latestJobRuns } from "./job-runs";

// Aggregated reliability signals for the Dashboard "System Health" strip
// (spec A.9): channel connectivity, AI engine failover, scheduled jobs, AI
// credit. All sources already exist — this only reads + shapes them.

export interface SystemHealth {
  channels: {
    id: number;
    label: string;
    status: string;
    connected: boolean;
    connectedAt: string | null;
    lastError: string | null;
  }[];
  engines: {
    engine: string;
    label: string;
    health: string;
    isEnabled: boolean;
    priority: number;
    unhealthyUntil: string | null;
  }[];
  jobs: {
    jobName: string;
    status: string; // 'ok' | 'failed' | 'running' | 'never'
    finishedAt: string | null;
    errorMessage: string | null;
  }[];
  credit: {
    usagePercent: number;
    tokenRemaining: number;
    projectedDaysRemaining: number | null;
    blocked: boolean;
    notifyLevel: string;
  } | null;
  overall: "ok" | "warning" | "critical";
}

const TRACKED_JOBS = ["ai_chat_report", "agent_quality", "crm_followup_poller"] as const;

export async function getSystemHealth(params: {
  ownerUserId: number;
  allowedChannelIds: Set<number>;
  includeCredit: boolean;
}): Promise<SystemHealth> {
  const { ownerUserId, allowedChannelIds, includeCredit } = params;

  // ── Channels (owner's channels, filtered to the requester's allowed set) ──
  const channelRows = await db
    .select({
      id: channelsTable.id,
      label: channelsTable.label,
      status: channelsTable.status,
      metadata: channelsTable.metadata,
    })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));

  const channels = channelRows
    .filter((c) => allowedChannelIds.has(c.id))
    .map((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      return {
        id: c.id,
        label: c.label,
        status: c.status,
        connected: c.status === "connected",
        connectedAt: typeof meta.connectedAt === "string" ? meta.connectedAt : null,
        lastError: typeof meta.lastError === "string" ? meta.lastError : null,
      };
    });

  // ── AI engines (platform-global circuit-breaker view) ────────────────────
  const engineView = await getEnginesView();
  const engines = engineView.map((e) => ({
    engine: e.engine,
    label: e.label,
    health: e.health,
    isEnabled: e.isEnabled,
    priority: e.priority,
    unhealthyUntil: e.unhealthyUntil,
  }));

  // ── Scheduled jobs (job_runs + AI Pipeline cutoff log) ───────────────────
  const jobMap = await latestJobRuns(ownerUserId, [...TRACKED_JOBS]);
  const jobs: SystemHealth["jobs"] = TRACKED_JOBS.map((name) => {
    const j = jobMap[name];
    return {
      jobName: name,
      status: j?.status ?? "never",
      finishedAt: j?.finishedAt ? j.finishedAt.toISOString() : null,
      errorMessage: j?.errorMessage ?? null,
    };
  });

  // AI Pipeline cut-off keeps its own log table — read its latest row directly.
  const [cutoff] = await db
    .select({
      status: aiPipelineCutoffLogsTable.status,
      completedAt: aiPipelineCutoffLogsTable.completedAt,
      errorMessage: aiPipelineCutoffLogsTable.errorMessage,
    })
    .from(aiPipelineCutoffLogsTable)
    .where(eq(aiPipelineCutoffLogsTable.ownerUserId, ownerUserId))
    .orderBy(desc(aiPipelineCutoffLogsTable.createdAt))
    .limit(1);
  jobs.unshift({
    jobName: "ai_pipeline_cutoff",
    status: cutoff ? (cutoff.status === "completed" ? "ok" : cutoff.status) : "never",
    finishedAt: cutoff?.completedAt ? cutoff.completedAt.toISOString() : null,
    errorMessage: cutoff?.errorMessage ?? null,
  });

  // ── Credit / token quota (owner-only) ────────────────────────────────────
  let credit: SystemHealth["credit"] = null;
  if (includeCredit) {
    const q = await getOwnerTokenQuota(ownerUserId);
    if (q) {
      credit = {
        usagePercent: q.usagePercent,
        tokenRemaining: q.tokenRemaining,
        projectedDaysRemaining: q.projectedDaysRemaining,
        blocked: q.blocked,
        notifyLevel: q.notifyLevel,
      };
    }
  }

  // ── Overall rollup ───────────────────────────────────────────────────────
  const anyChannelDown = channels.length > 0 && channels.some((c) => !c.connected);
  const anyJobFailed = jobs.some((j) => j.status === "failed");
  const creditCritical = credit?.blocked === true;
  const creditWarning = credit !== null && credit.usagePercent >= 90;

  let overall: SystemHealth["overall"] = "ok";
  if (anyChannelDown || creditCritical) overall = "critical";
  else if (anyJobFailed || creditWarning) overall = "warning";

  return { channels, engines, jobs, credit, overall };
}
