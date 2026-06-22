import { and, desc, eq } from "drizzle-orm";
import { db, acrJobsTable, acrAgentScoresTable } from "@workspace/db";

// Papan KPI Agent leaderboard (spec A.8 / 5.4). All six dimensions are already
// computed per agent per ACR job (acr_agent_scores) — response time & missed
// chats deterministically, language/answer/complaint by AI. So the leaderboard
// just reads the latest completed ACR job and sorts by the chosen dimension; no
// separate recompute is needed (reuse-ACR decision).

export type AgentKpiDimension =
  | "kpi"
  | "speed"
  | "lang"
  | "accuracy"
  | "complaint"
  | "unanswered";

// ASC dimensions: smaller is better (faster reply, fewer missed). Others DESC.
const ASC_DIMENSIONS: ReadonlySet<AgentKpiDimension> = new Set(["speed", "unanswered"]);

// Whether a dimension is AI-judged (for the "dinilai AI" badge).
export const AI_DIMENSIONS: ReadonlySet<AgentKpiDimension> = new Set([
  "lang",
  "accuracy",
  "complaint",
]);

export interface AgentKpiRow {
  agentUserId: number;
  name: string;
  value: number | null;
  grade: string;
  insufficientData: boolean;
}

export interface AgentKpiResult {
  dimension: AgentKpiDimension;
  ascending: boolean;
  jobId: string | null;
  periodEnd: string | null;
  rows: AgentKpiRow[];
}

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function agentKpiLeaderboard(
  ownerUserId: number,
  dimension: AgentKpiDimension
): Promise<AgentKpiResult> {
  const ascending = ASC_DIMENSIONS.has(dimension);

  const [job] = await db
    .select({ id: acrJobsTable.id, periodEnd: acrJobsTable.periodEnd })
    .from(acrJobsTable)
    .where(and(eq(acrJobsTable.ownerUserId, ownerUserId), eq(acrJobsTable.status, "completed")))
    .orderBy(desc(acrJobsTable.createdAt))
    .limit(1);

  if (!job) {
    return { dimension, ascending, jobId: null, periodEnd: null, rows: [] };
  }

  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, job.id));

  const rows: AgentKpiRow[] = scores.map((s) => {
    let value: number | null;
    switch (dimension) {
      case "speed":
        value = num(s.avgResponseTimeMinutes);
        break;
      case "lang":
        value = num(s.scoreLanguageQuality);
        break;
      case "accuracy":
        value = num(s.scoreAnswerQuality);
        break;
      case "complaint":
        value = num(s.scoreComplaintHandling);
        break;
      case "unanswered":
        value = s.totalMissedChats;
        break;
      case "kpi":
      default:
        value = num(s.totalScore);
        break;
    }
    return {
      agentUserId: s.agentUserId,
      name: s.agentName || s.agentEmail || `User ${s.agentUserId}`,
      value,
      grade: s.grade,
      insufficientData: s.insufficientData,
    };
  });

  // Sort: nulls always last; then by direction.
  rows.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return ascending ? a.value - b.value : b.value - a.value;
  });

  return {
    dimension,
    ascending,
    jobId: job.id,
    periodEnd: job.periodEnd,
    rows,
  };
}

// Tier-2 Agent KPI (spec A.10) — every dimension for every agent in one table,
// plus the AI coaching narrative per agent. Reads the same latest completed ACR
// job as the Tier-1 leaderboard; sorted by composite score (best first).
export interface AgentKpiTableRow {
  agentUserId: number;
  name: string;
  email: string | null;
  role: string;
  grade: string;
  insufficientData: boolean;
  kpi: number | null;
  speed: number | null; // avg first-reply minutes (lower better)
  lang: number | null;
  accuracy: number | null;
  complaint: number | null;
  unanswered: number; // missed chats (lower better)
  totalConversations: number;
  // AI coaching detail (spec A.10 "rincian coaching per agent").
  aiSummary: string | null;
  aiStrengths: string | null;
  aiImprovements: string | null;
}

export interface AgentKpiTableResult {
  jobId: string | null;
  periodEnd: string | null;
  rows: AgentKpiTableRow[];
}

export async function agentKpiTable(ownerUserId: number): Promise<AgentKpiTableResult> {
  const [job] = await db
    .select({ id: acrJobsTable.id, periodEnd: acrJobsTable.periodEnd })
    .from(acrJobsTable)
    .where(and(eq(acrJobsTable.ownerUserId, ownerUserId), eq(acrJobsTable.status, "completed")))
    .orderBy(desc(acrJobsTable.createdAt))
    .limit(1);

  if (!job) return { jobId: null, periodEnd: null, rows: [] };

  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, job.id));

  const rows: AgentKpiTableRow[] = scores.map((s) => ({
    agentUserId: s.agentUserId,
    name: s.agentName || s.agentEmail || `User ${s.agentUserId}`,
    email: s.agentEmail,
    role: s.agentRole,
    grade: s.grade,
    insufficientData: s.insufficientData,
    kpi: num(s.totalScore),
    speed: num(s.avgResponseTimeMinutes),
    lang: num(s.scoreLanguageQuality),
    accuracy: num(s.scoreAnswerQuality),
    complaint: num(s.scoreComplaintHandling),
    unanswered: s.totalMissedChats,
    totalConversations: s.totalConversations,
    aiSummary: s.aiSummary,
    aiStrengths: s.aiStrengths,
    aiImprovements: s.aiImprovements,
  }));

  // Composite score desc; nulls last; insufficient-data agents sink to the bottom.
  rows.sort((a, b) => {
    if (a.insufficientData !== b.insufficientData) return a.insufficientData ? 1 : -1;
    const av = a.kpi ?? -1;
    const bv = b.kpi ?? -1;
    return bv - av;
  });

  return { jobId: job.id, periodEnd: job.periodEnd, rows };
}
