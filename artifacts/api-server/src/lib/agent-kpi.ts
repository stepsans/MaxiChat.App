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
