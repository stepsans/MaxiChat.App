// AI Chat Report — WhatsApp delivery (Bagian IV 9.4 / 9.7 + schedule PDF).
//
// Anti-broadcast posture (deliberate):
//  - Agent coaching (9.4) and group summary (9.7) are MANUAL only (an admin
//    triggers them per report) — never auto-fired on every scheduled run.
//  - Scheduled PDF delivery goes only to the schedule's explicit notify list.
//  - Every send paces with a per-message random delay + typing presence, only
//    targets recipients that have a real phone number, and caps the fan-out.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  tenantSettingsTable,
  usersTable,
  acrJobsTable,
  acrAgentScoresTable,
  acrKpiSnapshotsTable,
  type AcrAgentScoreRow,
  type AcrCoachingInsights,
} from "@workspace/db";
import { resolveAiClient, type ResolvedAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { buildAcrPdf } from "./acr-pdf";
import { acrRedFlagsTable } from "@workspace/db";
import {
  ACR_SYSTEM_PROMPT_WA_COACHING,
  ACR_SYSTEM_PROMPT_WA_GROUP,
  buildWaCoachingUserPrompt,
  buildWaGroupUserPrompt,
} from "./acr-prompts";
import { logger } from "./logger";

// Hard cap on per-call fan-out so a misconfiguration can never blast hundreds.
const MAX_COACHING_RECIPIENTS = 50;

const N = (v: string | null): number => (v == null ? 0 : Number(v));

export interface AcrSendResult {
  sent: number;
  skipped: number;
  total: number;
  reason?: string;
}

function phoneToJid(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// A target JID: passthrough for a group ("...@g.us") or full JID, else a phone.
function toJid(target: string): string | null {
  if (target.includes("@")) return target;
  return phoneToJid(target);
}

async function delayBoundsFor(
  ownerUserId: number
): Promise<{ min: number; max: number }> {
  const row = await db.query.tenantSettingsTable.findFirst({
    where: eq(tenantSettingsTable.ownerUserId, ownerUserId),
  });
  // Slightly more conservative floor than chat replies for unsolicited sends.
  return { min: Math.max(2, row?.replyDelayMin ?? 2), max: Math.max(5, row?.replyDelayMax ?? 5) };
}

// First connected WhatsApp channel for the owner that has a live socket.
async function resolveOwnerWaChannel(ownerUserId: number): Promise<number | null> {
  const { getSockForChannel } = await import("../routes/whatsapp");
  const channels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(
      and(
        eq(channelsTable.userId, ownerUserId),
        eq(channelsTable.kind, "whatsapp"),
        eq(channelsTable.status, "connected")
      )
    );
  for (const c of channels) {
    if (getSockForChannel(c.id)) return c.id;
  }
  return null;
}

// Plain-text AI call (prompts 4/5 return prose, not JSON). Best-effort.
async function callAiText(
  resolved: ResolvedAiClient,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string | null> {
  const { client, model, provider, ownerUserId } = resolved;
  try {
    const completion = (await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    })) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    await recordAiUsage({ ownerUserId, channelId: null, provider, model, usage: completion.usage ?? null });
    const text = (completion.choices?.[0]?.message?.content ?? "").trim();
    return text || null;
  } catch (err) {
    logger.error({ err }, "[acr-wa] AI text generation failed");
    return null;
  }
}

function buildCoachingMessageInput(
  s: AcrAgentScoreRow,
  cfg: Record<string, unknown>,
  rank: number,
  totalAgents: number,
  teamAvg: number
) {
  const w = (k: string, d: number): number => Number(cfg[k] ?? d);
  const dims = [
    { label: "Kecepatan Balas", score: N(s.scoreResponseTime), max: w("weightResponseTime", 25) },
    { label: "Kualitas Bahasa", score: N(s.scoreLanguageQuality), max: w("weightLanguageQuality", 25) },
    { label: "Ketepatan Jawaban", score: N(s.scoreAnswerQuality), max: w("weightAnswerQuality", 25) },
    { label: "Handling Komplain", score: N(s.scoreComplaintHandling), max: w("weightComplaintHandling", 15) },
    { label: "Chat Tak Terjawab", score: N(s.scoreMissedChat), max: w("weightMissedChat", 10) },
  ];
  const ratio = (d: (typeof dims)[number]) => (d.max > 0 ? d.score / d.max : 0);
  const strong = [...dims].sort((a, b) => ratio(b) - ratio(a))[0]!;
  const weak = [...dims].sort((a, b) => ratio(a) - ratio(b))[0]!;
  const ci = s.coachingInsights as AcrCoachingInsights | null;
  return {
    scoreLines: dims.map((d) => `${d.label}: ${d.score} / ${d.max}`).join("\n"),
    strongest: `${strong.label} — ${strong.score} / ${strong.max}`,
    weakest: `${weak.label} — ${weak.score} / ${weak.max}`,
    redFlagSummary: `Total red flag: ${s.redFlagCount}`,
    rank,
    totalAgents,
    teamAvg,
    improvements: ci?.top_improvements ?? [],
  };
}

// 9.4 — MANUAL: send personal coaching to each evaluated agent's own WhatsApp.
export async function sendAgentCoachingWa(
  ownerUserId: number,
  jobId: string
): Promise<AcrSendResult> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job || job.ownerUserId !== ownerUserId)
    return { sent: 0, skipped: 0, total: 0, reason: "Job tidak ditemukan." };

  const channelId = await resolveOwnerWaChannel(ownerUserId);
  if (!channelId)
    return { sent: 0, skipped: 0, total: 0, reason: "Tidak ada channel WhatsApp aktif." };

  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId))
    .orderBy(sql`${acrAgentScoresTable.totalScore} desc`);
  if (scores.length === 0) return { sent: 0, skipped: 0, total: 0, reason: "Belum ada skor." };

  const snap = await db.query.acrKpiSnapshotsTable.findFirst({
    where: eq(acrKpiSnapshotsTable.jobId, jobId),
  });
  const teamAvg = N(snap?.teamAvgScore ?? null);
  const periodLabel = snap?.periodLabel ?? `${job.periodStart}..${job.periodEnd}`;

  // Resolve agent phone numbers.
  const ids = scores.map((s) => s.agentUserId);
  const users = await db
    .select({ id: usersTable.id, phone: usersTable.mobilePhone })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  const phoneOf = new Map(users.map((u) => [u.id, u.phone]));

  const resolvedAi = await resolveAiClient(ownerUserId);
  const bounds = await delayBoundsFor(ownerUserId);
  const { sendOneOffWaText } = await import("../routes/whatsapp");

  let sent = 0;
  let skipped = 0;
  const recipients = scores.slice(0, MAX_COACHING_RECIPIENTS);
  for (let i = 0; i < recipients.length; i++) {
    const s = recipients[i]!;
    const jid = phoneToJid(phoneOf.get(s.agentUserId));
    if (!jid) {
      skipped++;
      continue;
    }
    const input = buildCoachingMessageInput(
      s,
      job.configSnapshot as Record<string, unknown>,
      i + 1,
      scores.length,
      teamAvg
    );
    const text = await callAiText(
      resolvedAi,
      ACR_SYSTEM_PROMPT_WA_COACHING,
      buildWaCoachingUserPrompt({
        agentName: s.agentName ?? `#${s.agentUserId}`,
        periodLabel,
        grade: s.grade,
        totalScore: N(s.totalScore),
        prevScore: null,
        ...input,
      }),
      600
    );
    if (!text) {
      skipped++;
      continue;
    }
    const ok = await sendOneOffWaText(channelId, jid, text, bounds);
    if (ok) sent++;
    else skipped++;
  }
  logger.info({ jobId, sent, skipped }, "[acr-wa] agent coaching dispatched");
  return { sent, skipped, total: scores.length };
}

// 9.7 — MANUAL: send ONE team summary to a phone or group JID.
export async function sendGroupSummaryWa(
  ownerUserId: number,
  jobId: string,
  target: string
): Promise<AcrSendResult> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job || job.ownerUserId !== ownerUserId)
    return { sent: 0, skipped: 0, total: 1, reason: "Job tidak ditemukan." };
  const jid = toJid(target);
  if (!jid) return { sent: 0, skipped: 1, total: 1, reason: "Tujuan tidak valid." };

  const channelId = await resolveOwnerWaChannel(ownerUserId);
  if (!channelId) return { sent: 0, skipped: 1, total: 1, reason: "Tidak ada channel WhatsApp aktif." };

  const snap = await db.query.acrKpiSnapshotsTable.findFirst({
    where: eq(acrKpiSnapshotsTable.jobId, jobId),
  });
  if (!snap) return { sent: 0, skipped: 1, total: 1, reason: "Snapshot KPI belum tersedia." };

  const weakest = (
    [
      ["Kecepatan Balas", N(snap.teamAvgResponseTime)],
      ["Kualitas Bahasa", N(snap.teamAvgLanguage)],
      ["Ketepatan Jawaban", N(snap.teamAvgAnswer)],
      ["Handling Komplain", N(snap.teamAvgComplaint)],
    ] as [string, number][]
  ).sort((a, b) => a[1] - b[1])[0][0];

  const resolvedAi = await resolveAiClient(ownerUserId);
  const text = await callAiText(
    resolvedAi,
    ACR_SYSTEM_PROMPT_WA_GROUP,
    buildWaGroupUserPrompt({
      teamName: "Tim CS",
      periodLabel: snap.periodLabel,
      totalAgents: snap.totalAgents,
      teamAvg: N(snap.teamAvgScore),
      prevTeamAvg: null,
      avgRt: snap.teamAvgResponseTime == null ? null : N(snap.teamAvgResponseTime),
      totalMissed: snap.totalMissedChats,
      bestName: snap.topPerformerName,
      bestScore: snap.topPerformerScore == null ? null : N(snap.topPerformerScore),
      bestGrade: snap.topPerformerGrade,
      mostImprovedName: null,
      mostImprovedDelta: null,
      gradeDist: `A:${snap.countGradeA} B:${snap.countGradeB} C:${snap.countGradeC} D:${snap.countGradeD} E:${snap.countGradeE}`,
      totalRedFlags: snap.totalRedFlags,
      prevRedFlags: null,
      topRedFlagType: "customer_angry",
      topRedFlagCount: snap.totalCustomerAngry,
      weakestDim: weakest,
      belowSeventyCount: 0,
    }),
    500
  );
  if (!text) return { sent: 0, skipped: 1, total: 1, reason: "Gagal membuat ringkasan." };

  const bounds = await delayBoundsFor(ownerUserId);
  const { sendOneOffWaText } = await import("../routes/whatsapp");
  const ok = await sendOneOffWaText(channelId, jid, text, bounds);
  return { sent: ok ? 1 : 0, skipped: ok ? 0 : 1, total: 1, reason: ok ? undefined : "Pengiriman gagal." };
}

// Scheduled PDF delivery: send the report PDF to the schedule's notify list
// only (bounded, opt-in via schedule.send_whatsapp_pdf). Auto, but small.
export async function sendScheduledPdfWa(
  ownerUserId: number,
  jobId: string,
  recipientUserIds: number[]
): Promise<AcrSendResult> {
  if (recipientUserIds.length === 0)
    return { sent: 0, skipped: 0, total: 0, reason: "Tidak ada penerima." };
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job) return { sent: 0, skipped: 0, total: 0, reason: "Job tidak ditemukan." };
  const channelId = await resolveOwnerWaChannel(ownerUserId);
  if (!channelId) return { sent: 0, skipped: recipientUserIds.length, total: recipientUserIds.length, reason: "Tidak ada channel WhatsApp aktif." };

  const agents = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId))
    .orderBy(sql`${acrAgentScoresTable.totalScore} desc`);
  const redFlags = await db.select().from(acrRedFlagsTable).where(eq(acrRedFlagsTable.jobId, jobId));
  const [owner] = await db
    .select({ name: usersTable.name, companyName: usersTable.companyName })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);
  const pdf = Buffer.from(
    await buildAcrPdf({
      job,
      agents,
      redFlags,
      businessName: owner?.companyName || owner?.name || "MaxiChat",
      generatedByName: "Otomatis (terjadwal)",
      includeRedFlags: true,
      includeCoaching: false,
    })
  );

  const recipients = await db
    .select({ id: usersTable.id, phone: usersTable.mobilePhone })
    .from(usersTable)
    .where(inArray(usersTable.id, recipientUserIds.slice(0, MAX_COACHING_RECIPIENTS)));
  const bounds = await delayBoundsFor(ownerUserId);
  const { sendOneOffWaDocument } = await import("../routes/whatsapp");
  const caption = `Laporan Kinerja CS — ${job.periodStart} s/d ${job.periodEnd}`;
  const fileName = `acr-${job.periodStart}_${job.periodEnd}.pdf`;

  let sent = 0;
  let skipped = 0;
  for (const r of recipients) {
    const jid = phoneToJid(r.phone);
    if (!jid) {
      skipped++;
      continue;
    }
    const ok = await sendOneOffWaDocument(channelId, jid, pdf, fileName, caption, bounds);
    if (ok) sent++;
    else skipped++;
  }
  logger.info({ jobId, sent, skipped }, "[acr-wa] scheduled PDF dispatched");
  return { sent, skipped, total: recipients.length };
}
