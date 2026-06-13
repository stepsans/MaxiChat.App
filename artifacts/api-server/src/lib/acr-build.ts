// AI Chat Report — pure calculation logic (Section 4 of the ACR spec).
// Deliberately db-free so it can be unit-tested (node:test) without touching
// @workspace/db, which connects to Postgres eagerly at import.

// ─── Config snapshot ────────────────────────────────────────────────────────

export interface AcrConfigSnapshot {
  weightResponseTime: number;
  weightLanguageQuality: number;
  weightAnswerQuality: number;
  weightComplaintHandling: number;
  weightMissedChat: number;

  slaExcellentMinutes: number;
  slaGoodMinutes: number;
  slaAcceptableMinutes: number;
  slaPoorMinutes: number;
  slaCriticalMinutes: number;

  gradeAThreshold: number;
  gradeBThreshold: number;
  gradeCThreshold: number;
  gradeDThreshold: number;

  allowanceGradeA: number;
  allowanceGradeB: number;
  allowanceGradeC: number;
  allowanceGradeD: number;
  allowanceGradeE: number;

  complaintHandlingEnabled: boolean;
  // Optional for backward-compat with snapshots taken before the toggle
  // existed; absent = false (owner not evaluated).
  includeOwnerInEvaluation?: boolean;
}

export function validateConfigInput(cfg: AcrConfigSnapshot): string | null {
  const weights = [
    cfg.weightResponseTime,
    cfg.weightLanguageQuality,
    cfg.weightAnswerQuality,
    cfg.weightComplaintHandling,
    cfg.weightMissedChat,
  ];
  if (weights.some((w) => !Number.isInteger(w) || w < 0 || w > 100)) {
    return "Bobot harus bilangan bulat 0–100.";
  }
  if (weights.reduce((a, b) => a + b, 0) !== 100) {
    return "Total bobot harus 100";
  }
  const sla = [
    cfg.slaExcellentMinutes,
    cfg.slaGoodMinutes,
    cfg.slaAcceptableMinutes,
    cfg.slaPoorMinutes,
    cfg.slaCriticalMinutes,
  ];
  if (sla.some((m) => !Number.isInteger(m) || m < 1)) {
    return "Target SLA harus bilangan bulat positif (menit).";
  }
  for (let i = 1; i < sla.length; i++) {
    if (sla[i]! <= sla[i - 1]!) {
      return "Target SLA harus naik: Excellent < Good < Acceptable < Poor < Critical.";
    }
  }
  const grades = [
    cfg.gradeAThreshold,
    cfg.gradeBThreshold,
    cfg.gradeCThreshold,
    cfg.gradeDThreshold,
  ];
  if (grades.some((g) => !Number.isInteger(g) || g < 1 || g > 100)) {
    return "Ambang grade harus bilangan bulat 1–100.";
  }
  for (let i = 1; i < grades.length; i++) {
    if (grades[i]! >= grades[i - 1]!) {
      return "Ambang grade harus menurun: A > B > C > D > 0.";
    }
  }
  const allowances = [
    cfg.allowanceGradeA,
    cfg.allowanceGradeB,
    cfg.allowanceGradeC,
    cfg.allowanceGradeD,
    cfg.allowanceGradeE,
  ];
  // Whole-integer Rupiah — OpenAPI integer codegens to zod.number() which
  // accepts decimals, so re-validate at the boundary.
  if (allowances.some((a) => !Number.isInteger(a) || a < 0)) {
    return "Tunjangan harus bilangan bulat Rupiah (tanpa desimal).";
  }
  return null;
}

// ─── Response-time metrics (Section 4.2–4.4) ────────────────────────────────

// What the metric calculator needs to know about each message.
export interface AcrMessage {
  id: number;
  direction: "inbound" | "outbound";
  // True for AI outbound sends.
  isAiGenerated: boolean;
  // The human (agent/supervisor) who sent an outbound message. NULL for
  // inbound, AI sends, bot-flow sends, and historical pre-column rows.
  // A message counts as HUMAN only when isAiGenerated=false AND sentByUserId
  // is not null (Section 4.1a). Everything else is automated context only.
  sentByUserId: number | null;
  content: string;
  createdAt: Date;
}

// A message authored by a human agent — the only kind that counts toward KPIs.
export function isHumanMessage(m: AcrMessage): boolean {
  return m.direction === "outbound" && !m.isAiGenerated && m.sentByUserId != null;
}

export interface CustomerIgnoredEvent {
  // Messages making up the unanswered repeat-ping turn (for the excerpt).
  turnMessageIds: number[];
  firstInboundAt: Date;
  repeatCount: number;
}

export interface ResponseMetrics {
  // Minutes between the first inbound of a customer turn and the next HUMAN
  // outbound reply. Turns answered by the AI/chatbot are excluded.
  responseTimesMinutes: number[];
  firstResponseTimeMinutes: number | null;
  avgResponseTimeMinutes: number | null;
  maxResponseTimeMinutes: number | null;
  // Customer turns that never got any reply (human or AI) in the window.
  missedTurns: number;
  // Total inbound customer messages (denominator basis for pct missed).
  totalCustomerMessages: number;
  totalAgentMessages: number;
  // Turns where the customer sent >= 2 messages before any reply arrived.
  customerIgnoredEvents: CustomerIgnoredEvent[];
  // Human response times that exceeded the critical SLA (red flag).
  noReplyCriticalEvents: Array<{ minutes: number; firstInboundAt: Date }>;
}

// Group consecutive inbound messages into "customer turns"; a turn's response
// time anchors on its FIRST inbound message (matches the spec's 4.3 example:
// the wait is measured from the original question, not the follow-up ping).
export function computeResponseMetrics(
  messages: AcrMessage[],
  slaCriticalMinutes: number
): ResponseMetrics {
  const sorted = [...messages].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );

  const responseTimes: number[] = [];
  const customerIgnoredEvents: CustomerIgnoredEvent[] = [];
  const noReplyCriticalEvents: ResponseMetrics["noReplyCriticalEvents"] = [];
  let missedTurns = 0;
  let totalCustomerMessages = 0;
  let totalAgentMessages = 0;

  let turn: AcrMessage[] = [];

  // Only a HUMAN outbound closes a customer turn (Section 4.1a/4.2/4.3). AI and
  // bot-flow sends are context only: they neither answer the turn nor credit a
  // response time, so a customer who pings again after just a bot reply still
  // counts as ignored, and the wait is measured to the next human reply.
  const closeTurn = (reply: AcrMessage | null) => {
    if (turn.length === 0) return;
    const first = turn[0]!;
    if (turn.length >= 2) {
      customerIgnoredEvents.push({
        turnMessageIds: turn.map((m) => m.id),
        firstInboundAt: first.createdAt,
        repeatCount: turn.length,
      });
    }
    if (!reply) {
      // No human ever replied (a bot may have) → missed.
      missedTurns++;
    } else {
      const minutes =
        (reply.createdAt.getTime() - first.createdAt.getTime()) / 60_000;
      responseTimes.push(minutes);
      if (minutes > slaCriticalMinutes) {
        noReplyCriticalEvents.push({ minutes, firstInboundAt: first.createdAt });
      }
    }
    turn = [];
  };

  for (const msg of sorted) {
    if (msg.direction === "inbound") {
      totalCustomerMessages++;
      turn.push(msg);
    } else if (isHumanMessage(msg)) {
      totalAgentMessages++;
      closeTurn(msg);
    }
    // AI/bot outbound: skip entirely (does not answer the turn).
  }
  closeTurn(null);

  const avg =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : null;
  const max = responseTimes.length > 0 ? Math.max(...responseTimes) : null;

  return {
    responseTimesMinutes: responseTimes,
    firstResponseTimeMinutes: responseTimes.length > 0 ? responseTimes[0]! : null,
    avgResponseTimeMinutes: avg,
    maxResponseTimeMinutes: max,
    missedTurns,
    totalCustomerMessages,
    totalAgentMessages,
    customerIgnoredEvents,
    noReplyCriticalEvents,
  };
}

// ─── Score conversions (Section 4.5–4.6) ────────────────────────────────────

// Raw 0–100 score from the average human response time.
export function responseTimeToRawScore(
  avgRtMinutes: number | null,
  cfg: AcrConfigSnapshot
): number {
  if (avgRtMinutes == null) return 100; // nothing to answer = no penalty
  if (avgRtMinutes <= cfg.slaExcellentMinutes) return 100;
  if (avgRtMinutes <= cfg.slaGoodMinutes) return 85;
  if (avgRtMinutes <= cfg.slaAcceptableMinutes) return 65;
  if (avgRtMinutes <= cfg.slaPoorMinutes) return 40;
  if (avgRtMinutes <= cfg.slaCriticalMinutes) return 15;
  return 0;
}

// Raw 0–100 score from the missed-chat percentage.
export function missedChatToRawScore(
  totalMissed: number,
  totalCustomerMessages: number
): number {
  if (totalCustomerMessages <= 0) return 100;
  const pct = (totalMissed / totalCustomerMessages) * 100;
  if (pct === 0) return 100;
  if (pct <= 5) return 75;
  if (pct <= 10) return 50;
  if (pct <= 20) return 25;
  return 0;
}

// ─── Aggregation (Section 4.7–4.8) ──────────────────────────────────────────

export interface AgentAggregateInput {
  rawResponseTimeScore: number; // 0–100
  rawMissedChatScore: number; // 0–100
  // AVG of per-conversation AI scores (0–100), null when no conversations.
  rawLanguageScore: number | null;
  rawAnswerScore: number | null;
  // AVG of complaint_handling over conversations WITH a complaint, or null
  // when the agent had no complaint conversations.
  rawComplaintScore: number | null;
}

export interface AgentAggregateResult {
  scoreResponseTime: number;
  scoreLanguageQuality: number;
  scoreAnswerQuality: number;
  scoreComplaintHandling: number;
  scoreMissedChat: number;
  totalScore: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Weighted total (0–100) from five raw 0–100 dimension scores. Honors the
// complaint-handling toggle exactly like aggregateAgentScores: when disabled,
// the complaint weight is redistributed proportionally across the other four
// dimensions (effective weight = weight_x / (100 - weight_complaint) × 100).
// Used for the per-conversation total so it stays consistent with the
// per-agent total when complaint handling is off.
export function weightedTotalScore(
  raws: {
    responseTime: number;
    language: number;
    answer: number;
    complaint: number;
    missed: number;
  },
  cfg: AcrConfigSnapshot
): number {
  if (!cfg.complaintHandlingEnabled) {
    const activeWeight = 100 - cfg.weightComplaintHandling;
    const scale = activeWeight > 0 ? 100 / activeWeight : 0;
    return round2(
      (raws.responseTime * cfg.weightResponseTime * scale +
        raws.language * cfg.weightLanguageQuality * scale +
        raws.answer * cfg.weightAnswerQuality * scale +
        raws.missed * cfg.weightMissedChat * scale) /
        100
    );
  }
  return round2(
    (raws.responseTime * cfg.weightResponseTime +
      raws.language * cfg.weightLanguageQuality +
      raws.answer * cfg.weightAnswerQuality +
      raws.complaint * cfg.weightComplaintHandling +
      raws.missed * cfg.weightMissedChat) /
      100
  );
}

// Convert raw 0–100 dimension scores to weighted contributions and sum.
// When complaint handling is disabled, its weight is redistributed to the
// other dimensions proportionally (each dimension's effective weight becomes
// weight_x / (100 - weight_complaint) × 100).
export function aggregateAgentScores(
  input: AgentAggregateInput,
  cfg: AcrConfigSnapshot
): AgentAggregateResult {
  const language = input.rawLanguageScore ?? 0;
  const answer = input.rawAnswerScore ?? 0;

  if (!cfg.complaintHandlingEnabled) {
    const activeWeight = 100 - cfg.weightComplaintHandling;
    const scale = activeWeight > 0 ? 100 / activeWeight : 0;
    const rt = (input.rawResponseTimeScore * cfg.weightResponseTime * scale) / 100;
    const lang = (language * cfg.weightLanguageQuality * scale) / 100;
    const ans = (answer * cfg.weightAnswerQuality * scale) / 100;
    const miss = (input.rawMissedChatScore * cfg.weightMissedChat * scale) / 100;
    return {
      scoreResponseTime: round2(rt),
      scoreLanguageQuality: round2(lang),
      scoreAnswerQuality: round2(ans),
      scoreComplaintHandling: 0,
      scoreMissedChat: round2(miss),
      // Sum the unrounded contributions so 4×(100×w/activeW) lands exactly
      // on 100 instead of drifting to 99.99 via per-dimension rounding.
      totalScore: round2(rt + lang + ans + miss),
    };
  }

  // No complaints in the period = default "good" (85), not perfect.
  const complaint = input.rawComplaintScore ?? 85;

  const scoreResponseTime = round2(
    (input.rawResponseTimeScore * cfg.weightResponseTime) / 100
  );
  const scoreLanguageQuality = round2((language * cfg.weightLanguageQuality) / 100);
  const scoreAnswerQuality = round2((answer * cfg.weightAnswerQuality) / 100);
  const scoreComplaintHandling = round2(
    (complaint * cfg.weightComplaintHandling) / 100
  );
  const scoreMissedChat = round2((input.rawMissedChatScore * cfg.weightMissedChat) / 100);

  return {
    scoreResponseTime,
    scoreLanguageQuality,
    scoreAnswerQuality,
    scoreComplaintHandling,
    scoreMissedChat,
    totalScore: round2(
      scoreResponseTime +
        scoreLanguageQuality +
        scoreAnswerQuality +
        scoreComplaintHandling +
        scoreMissedChat
    ),
  };
}

export type AcrGrade = "A" | "B" | "C" | "D" | "E";

export function gradeFor(totalScore: number, cfg: AcrConfigSnapshot): AcrGrade {
  if (totalScore >= cfg.gradeAThreshold) return "A";
  if (totalScore >= cfg.gradeBThreshold) return "B";
  if (totalScore >= cfg.gradeCThreshold) return "C";
  if (totalScore >= cfg.gradeDThreshold) return "D";
  return "E";
}

export function allowanceFor(grade: AcrGrade, cfg: AcrConfigSnapshot): number {
  switch (grade) {
    case "A":
      return cfg.allowanceGradeA;
    case "B":
      return cfg.allowanceGradeB;
    case "C":
      return cfg.allowanceGradeC;
    case "D":
      return cfg.allowanceGradeD;
    default:
      return cfg.allowanceGradeE;
  }
}

// ─── Transcript building (Section 15.4) ─────────────────────────────────────

// Cap at 50 messages: when longer, keep the 10 first (opening context) +
// 40 most recent.
export function capTranscriptMessages<T>(messages: T[]): T[] {
  if (messages.length <= 50) return messages;
  return [...messages.slice(0, 10), ...messages.slice(-40)];
}

// "2025-06-24 10:00" in the tenant's timezone (Asia/Jakarta / WIB).
export function formatWibTimestamp(d: Date): string {
  const wib = new Date(d.getTime() + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${wib.getUTCFullYear()}-${p(wib.getUTCMonth() + 1)}-${p(
    wib.getUTCDate()
  )} ${p(wib.getUTCHours())}:${p(wib.getUTCMinutes())}`;
}

// ─── Period boundaries ──────────────────────────────────────────────────────

// period_start/end are DATEs in the tenant's timezone (default Asia/Jakarta).
// Convert to UTC instants covering the whole local days.
export function periodToUtcRange(
  periodStart: string,
  periodEnd: string
): { start: Date; end: Date } {
  return {
    start: new Date(`${periodStart}T00:00:00+07:00`),
    end: new Date(`${periodEnd}T23:59:59.999+07:00`),
  };
}

// Today's date (YYYY-MM-DD) in WIB.
export function todayWib(now: Date = new Date()): string {
  const wib = new Date(now.getTime() + 7 * 3600_000);
  return wib.toISOString().slice(0, 10);
}

// ─── AI output parsing ──────────────────────────────────────────────────────

export interface ConversationAiResult {
  language_quality_score: number;
  answer_quality_score: number;
  complaint_handling_score: number;
  has_complaint: boolean;
  complaint_resolved: boolean;
  answer_caused_customer_silent: boolean;
  red_flags: Array<{
    type: "customer_angry" | "rude_language" | "answer_caused_dropout";
    severity: "critical" | "high" | "medium";
    explanation: string;
    recommendation: string;
    excerpt: string;
  }>;
  ai_notes: string;
}

const AI_RED_FLAG_TYPES = new Set([
  "customer_angry",
  "rude_language",
  "answer_caused_dropout",
]);
const SEVERITIES = new Set(["critical", "high", "medium"]);

function clampScore(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// Strip an optional ```json fence and parse. Returns null on failure so the
// caller can retry / fall back.
export function parseAiJson(raw: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw.trim());
  if (direct) return direct;
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  const fenced = tryParse(cleaned);
  if (fenced) return fenced;
  // Last resort: widest {...} slice.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(raw.slice(start, end + 1));
  return null;
}

// Default used when the AI call ultimately fails (per the spec's retry
// snippet): neutral scores so one bad call doesn't sink the whole job.
export function defaultConversationAiResult(): ConversationAiResult {
  return {
    language_quality_score: 70,
    answer_quality_score: 70,
    complaint_handling_score: 85,
    has_complaint: false,
    complaint_resolved: false,
    answer_caused_customer_silent: false,
    red_flags: [],
    ai_notes: "Analisa tidak tersedia (error saat memproses)",
  };
}

export function normalizeConversationAiResult(
  parsed: Record<string, unknown>
): ConversationAiResult {
  const hasComplaint = parsed.has_complaint === true;
  const flagsRaw = Array.isArray(parsed.red_flags) ? parsed.red_flags : [];
  const red_flags: ConversationAiResult["red_flags"] = [];
  for (const f of flagsRaw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (!AI_RED_FLAG_TYPES.has(type)) continue;
    const severity =
      typeof o.severity === "string" && SEVERITIES.has(o.severity)
        ? (o.severity as "critical" | "high" | "medium")
        : "medium";
    red_flags.push({
      type: type as "customer_angry" | "rude_language" | "answer_caused_dropout",
      severity,
      explanation:
        typeof o.explanation === "string" ? o.explanation.slice(0, 300) : "",
      recommendation:
        typeof o.recommendation === "string" ? o.recommendation.slice(0, 250) : "",
      excerpt: typeof o.excerpt === "string" ? o.excerpt.slice(0, 500) : "",
    });
  }
  return {
    language_quality_score: clampScore(parsed.language_quality_score, 70),
    answer_quality_score: clampScore(parsed.answer_quality_score, 70),
    complaint_handling_score: clampScore(
      parsed.complaint_handling_score,
      hasComplaint ? 70 : 85
    ),
    has_complaint: hasComplaint,
    complaint_resolved: hasComplaint && parsed.complaint_resolved === true,
    answer_caused_customer_silent: parsed.answer_caused_customer_silent === true,
    red_flags,
    ai_notes: typeof parsed.ai_notes === "string" ? parsed.ai_notes.slice(0, 400) : "",
  };
}

export interface CoachingAiResult {
  ai_summary: string;
  ai_strengths: string;
  ai_improvements: string;
  top_improvements: string[];
  best_conversation_id: string | null;
  best_conversation_excerpt: string;
  worst_conversation_id: string | null;
  worst_conversation_excerpt: string;
  worst_conversation_annotation: string;
}

export function normalizeCoachingAiResult(
  parsed: Record<string, unknown>
): CoachingAiResult {
  const str = (v: unknown, max = 2000): string =>
    typeof v === "string" ? v.slice(0, max) : "";
  const idOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null"
      ? v.trim()
      : null;
  const improvements = Array.isArray(parsed.top_improvements)
    ? parsed.top_improvements
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, 3)
    : [];
  return {
    ai_summary: str(parsed.ai_summary),
    ai_strengths: str(parsed.ai_strengths),
    ai_improvements: str(parsed.ai_improvements),
    top_improvements: improvements,
    best_conversation_id: idOrNull(parsed.best_conversation_id),
    best_conversation_excerpt: str(parsed.best_conversation_excerpt, 400),
    worst_conversation_id: idOrNull(parsed.worst_conversation_id),
    worst_conversation_excerpt: str(parsed.worst_conversation_excerpt, 400),
    worst_conversation_annotation: str(parsed.worst_conversation_annotation, 500),
  };
}

// ─── Red flag → score impact (Section 6.4 Tab 4 "Dampak ke Skor") ──────────

// Which weighted dimension a violation type drags down.
export const VIOLATION_DIMENSION: Record<string, string> = {
  customer_angry: "complaint_handling",
  rude_language: "language_quality",
  answer_caused_dropout: "answer_quality",
  no_reply_critical: "response_time",
  customer_ignored: "response_time",
};

// Quantify each flag's share of the points lost in its dimension: the gap
// between the dimension's full weight and the achieved weighted score, split
// evenly across the flags hitting that dimension.
export function computeRedFlagImpacts(
  flags: Array<{ violationType: string }>,
  weighted: AgentAggregateResult,
  cfg: AcrConfigSnapshot
): Array<{ dimension: string; points: number }> {
  const lostByDimension: Record<string, number> = {
    response_time: Math.max(0, cfg.weightResponseTime - weighted.scoreResponseTime),
    language_quality: Math.max(
      0,
      cfg.weightLanguageQuality - weighted.scoreLanguageQuality
    ),
    answer_quality: Math.max(0, cfg.weightAnswerQuality - weighted.scoreAnswerQuality),
    complaint_handling: Math.max(
      0,
      cfg.weightComplaintHandling - weighted.scoreComplaintHandling
    ),
    missed_chat: Math.max(0, cfg.weightMissedChat - weighted.scoreMissedChat),
  };
  const countByDimension: Record<string, number> = {};
  for (const f of flags) {
    const dim = VIOLATION_DIMENSION[f.violationType] ?? "response_time";
    countByDimension[dim] = (countByDimension[dim] ?? 0) + 1;
  }
  return flags.map((f) => {
    const dim = VIOLATION_DIMENSION[f.violationType] ?? "response_time";
    const n = countByDimension[dim] ?? 1;
    return { dimension: dim, points: round2((lostByDimension[dim] ?? 0) / n) };
  });
}

// ─── Auto-schedule (Section 13) ─────────────────────────────────────────────

export interface AutoScheduleConfig {
  frequency: "weekly" | "monthly" | "custom";
  dayOfMonth: number; // 1–28 (monthly)
  dayOfWeek: number; // 1=Senin … 7=Minggu (weekly)
  everyDays: number; // custom interval in days
}

// Next run instant strictly after `after`, at 06:00 WIB on the target day.
export function computeNextRunAt(cfg: AutoScheduleConfig, after: Date): Date {
  const RUN_HOUR_WIB = 6;
  const wibNow = new Date(after.getTime() + 7 * 3600_000);
  const mk = (y: number, m: number, d: number): Date =>
    // 06:00 WIB == 23:00 UTC the previous day.
    new Date(Date.UTC(y, m, d, RUN_HOUR_WIB - 7, 0, 0));

  if (cfg.frequency === "weekly") {
    // JS getUTCDay(): 0=Sunday…6=Saturday → spec: 1=Senin…7=Minggu.
    const targetJsDay = cfg.dayOfWeek % 7; // 7 (Minggu) → 0
    for (let i = 0; i <= 14; i++) {
      const cand = new Date(
        Date.UTC(
          wibNow.getUTCFullYear(),
          wibNow.getUTCMonth(),
          wibNow.getUTCDate() + i
        )
      );
      if (cand.getUTCDay() !== targetJsDay) continue;
      const runAt = mk(
        cand.getUTCFullYear(),
        cand.getUTCMonth(),
        cand.getUTCDate()
      );
      if (runAt.getTime() > after.getTime()) return runAt;
    }
  }

  if (cfg.frequency === "monthly") {
    const day = Math.min(28, Math.max(1, cfg.dayOfMonth));
    const thisMonth = mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), day);
    if (thisMonth.getTime() > after.getTime()) return thisMonth;
    return mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth() + 1, day);
  }

  // custom: every N days from now.
  const days = Math.max(1, cfg.everyDays);
  const cand = new Date(
    Date.UTC(
      wibNow.getUTCFullYear(),
      wibNow.getUTCMonth(),
      wibNow.getUTCDate() + days
    )
  );
  return mk(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate());
}

// Period for an auto-scheduled job ending today (WIB).
export function autoSchedulePeriod(
  frequency: "weekly" | "monthly" | "custom",
  everyDays: number,
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const end = todayWib(now);
  const days = frequency === "weekly" ? 7 : frequency === "custom" ? Math.max(1, everyDays) : 30;
  const startDate = new Date(new Date(`${end}T00:00:00Z`).getTime() - days * 86_400_000);
  return { periodStart: startDate.toISOString().slice(0, 10), periodEnd: end };
}

// ─── Multi-schedule (Bagian II: acr_schedules) ──────────────────────────────

export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export interface ScheduleSpec {
  frequency: ScheduleFrequency;
  dayOfWeek?: number | null; // 0=Sunday … 6=Saturday (weekly)
  dayOfMonth?: number | null; // 1–28 (monthly)
  cutoffHour: number; // 0–23 (WIB)
  cutoffMinute: number; // 0–59
}

// Next run instant strictly after `after`, at cutoffHour:cutoffMinute WIB.
// Mirrors computeNextRunAt but supports daily + an arbitrary cutoff time and
// the JS day-of-week convention (0=Sunday) used by acr_schedules.
export function computeScheduleNextRun(s: ScheduleSpec, after: Date): Date {
  const wibNow = new Date(after.getTime() + 7 * 3600_000);
  const h = Math.min(23, Math.max(0, s.cutoffHour));
  const min = Math.min(59, Math.max(0, s.cutoffMinute));
  // cutoff h:min WIB == (h-7):min UTC; Date.UTC normalizes negative hours.
  const mk = (y: number, m: number, d: number): Date =>
    new Date(Date.UTC(y, m, d, h - 7, min, 0));

  if (s.frequency === "daily") {
    const today = mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate());
    if (today.getTime() > after.getTime()) return today;
    return mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + 1);
  }

  if (s.frequency === "weekly") {
    const targetJsDay = (((s.dayOfWeek ?? 0) % 7) + 7) % 7;
    for (let i = 0; i <= 14; i++) {
      const cand = new Date(
        Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + i)
      );
      if (cand.getUTCDay() !== targetJsDay) continue;
      const runAt = mk(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate());
      if (runAt.getTime() > after.getTime()) return runAt;
    }
  }

  // monthly (day clamped to 1–28, so every month has it).
  const day = Math.min(28, Math.max(1, s.dayOfMonth ?? 1));
  const thisMonth = mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), day);
  if (thisMonth.getTime() > after.getTime()) return thisMonth;
  return mk(wibNow.getUTCFullYear(), wibNow.getUTCMonth() + 1, day);
}

// Period covered by a scheduled job ending today (WIB): daily=1d, weekly=7d,
// monthly=30d before today.
export function schedulePeriod(
  frequency: ScheduleFrequency,
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const end = todayWib(now);
  const days = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 30;
  const startDate = new Date(new Date(`${end}T00:00:00Z`).getTime() - days * 86_400_000);
  return { periodStart: startDate.toISOString().slice(0, 10), periodEnd: end };
}

const ID_MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const ID_MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
];

// ISO-8601 week number of a UTC date (Monday-based).
function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

// Human label for a report period (Bahasa Indonesia).
export function buildPeriodLabel(
  frequency: ScheduleFrequency | "manual",
  periodStart: string,
  periodEnd: string
): string {
  const ps = new Date(`${periodStart}T00:00:00Z`);
  const pe = new Date(`${periodEnd}T00:00:00Z`);
  const fmt = (d: Date) =>
    `${d.getUTCDate()} ${ID_MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (frequency === "daily") return fmt(pe);
  if (frequency === "weekly") return `Minggu ke-${isoWeek(ps)}, ${ps.getUTCFullYear()}`;
  if (frequency === "monthly") return `${ID_MONTHS[ps.getUTCMonth()]} ${ps.getUTCFullYear()}`;
  const sameYear = ps.getUTCFullYear() === pe.getUTCFullYear();
  const left = `${ps.getUTCDate()} ${ID_MONTHS_SHORT[ps.getUTCMonth()]}${
    sameYear ? "" : ` ${ps.getUTCFullYear()}`
  }`;
  return `${left} – ${fmt(pe)}`;
}
