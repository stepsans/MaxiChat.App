// Pure (db-free) logic for the lead-learning loop. Two jobs:
//  1. decideReviewTrigger — given an AI verdict + the contact's manual label,
//     decide whether to ask the tenant a clarifying question (and why).
//  2. buildLessonsBlock — compress past manual corrections into a compact
//     prompt section so the AI Pipeline converges on THIS tenant's definition
//     of lead/not-lead over time.
//
// Kept db-free so it is unit-testable in isolation (see lead-learning.test.ts);
// all DB reads/writes happen at the call site in ai-pipeline-analysis.ts /
// routes/lead-reviews.ts.

export type LeadVerdict = "lead" | "not_lead";
export type ReviewTrigger = "conflict" | "uncertain";

// How close to scoreThreshold counts as "borderline" → ask the tenant.
export const DEFAULT_UNCERTAIN_BAND = 8;

export interface ReviewDecisionInput {
  contactName: string | null;
  score: number;
  scoreThreshold: number;
  conversationRole: string; // tenant_is_seller | tenant_is_buyer | unclear
  skipped: boolean;
  leadClassification: string; // lead | not_lead | unclear
  // The contact's current contact_lead_status row, if any. Only a 'manual' row
  // carries authority for conflict detection — an 'ai' row is just a prior guess.
  manual: { leadStatus: string; leadClassifiedBy: string } | null | undefined;
  uncertainBand?: number;
}

export interface ReviewDecision {
  needsReview: boolean;
  trigger: ReviewTrigger | null;
  aiSuggestedStatus: LeadVerdict;
  question: string | null;
}

function labelId(status: string): string {
  return status === "lead" ? "Lead" : status === "not_lead" ? "Not Lead" : "Unknown";
}

// Collapse an AI analysis result into a single lead/not-lead lean.
export function aiSuggestedStatusOf(input: {
  skipped: boolean;
  leadClassification: string;
  score: number;
  scoreThreshold: number;
}): LeadVerdict {
  if (input.skipped) return "not_lead";
  if (input.leadClassification === "lead" || input.score >= input.scoreThreshold) {
    return "lead";
  }
  return "not_lead";
}

export function decideReviewTrigger(input: ReviewDecisionInput): ReviewDecision {
  const band = input.uncertainBand ?? DEFAULT_UNCERTAIN_BAND;
  const aiSuggestedStatus = aiSuggestedStatusOf(input);

  const manualStatus =
    input.manual?.leadClassifiedBy === "manual" ? input.manual.leadStatus : null;

  let trigger: ReviewTrigger | null = null;

  // Conflict wins: the AI wants the opposite of an explicit human label.
  if (
    (manualStatus === "lead" && aiSuggestedStatus === "not_lead") ||
    (manualStatus === "not_lead" && aiSuggestedStatus === "lead")
  ) {
    trigger = "conflict";
  } else {
    // Uncertain: borderline score, or an unclear role on a chat we did not skip.
    const borderline =
      !input.skipped && Math.abs(input.score - input.scoreThreshold) <= band;
    const unclearRole = input.conversationRole === "unclear" && !input.skipped;
    if (borderline || unclearRole) trigger = "uncertain";
  }

  const name = input.contactName?.trim() || "Kontak ini";
  let question: string | null = null;
  if (trigger === "conflict") {
    question = `${name}: AI menilai "${labelId(aiSuggestedStatus)}", tapi label manualmu "${labelId(
      manualStatus as string
    )}". Mana yang benar?`;
  } else if (trigger === "uncertain") {
    question = `${name}: AI ragu (skor ${input.score}, ambang ${input.scoreThreshold}). Ini lead atau bukan?`;
  }

  return { needsReview: trigger !== null, trigger, aiSuggestedStatus, question };
}

export interface LessonRow {
  fromStatus: string;
  toStatus: string;
  reason?: string | null;
  contextSummary?: string | null;
  aiConversationRole?: string | null;
}

const MAX_LESSON_CHARS = 140;

function trunc(s: string, max = MAX_LESSON_CHARS): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// Build the "PELAJARAN DARI TENANT" prompt section from recent corrections.
// Only rows that carry a reason or a context summary teach anything, so blanks
// are dropped. Returns "" when there is nothing to teach (caller appends
// nothing). `limit` caps how many lessons reach the prompt (token safety).
export function buildLessonsBlock(rows: LessonRow[], limit = 20): string {
  const useful = rows
    .filter((r) => (r.reason && r.reason.trim()) || (r.contextSummary && r.contextSummary.trim()))
    .slice(0, limit);
  if (useful.length === 0) return "";

  const lines = useful.map((r) => {
    const verdict = labelId(r.toStatus).toLowerCase();
    const why = r.reason?.trim() ? `"${trunc(r.reason)}"` : "(tanpa alasan)";
    const ctx = r.contextSummary?.trim() ? ` — konteks: ${trunc(r.contextSummary, 80)}` : "";
    const aiWas =
      r.aiConversationRole && r.aiConversationRole !== "unclear"
        ? ` (AI sempat: ${r.aiConversationRole})`
        : "";
    return `- [${verdict}] ${why}${ctx}${aiWas}`;
  });

  return `PELAJARAN DARI TENANT (koreksi manual sebelumnya — JADIKAN PANDUAN saat menentukan conversation_role & lead_classification; bila percakapan baru mirip pola di bawah, ikuti keputusan yang sama):
${lines.join("\n")}

`;
}
