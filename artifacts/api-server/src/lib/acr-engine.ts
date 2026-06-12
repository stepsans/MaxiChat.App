// AI Chat Report — asynchronous job runner (Section 4–5 of the ACR spec).
//
// Flow per job: discover agents (human outbound authors in the period) →
// per conversation compute deterministic metrics + 1 AI quality call →
// aggregate per agent → 1 coaching AI call per agent → leaderboard stats →
// red-flag notifications. All calculations use the job's immutable
// config_snapshot, never the live config.

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  acrJobsTable,
  acrAgentScoresTable,
  acrConversationScoresTable,
  acrRedFlagsTable,
  acrNotificationsTable,
  chatsTable,
  chatMessagesTable,
  channelsTable,
  usersTable,
  userChannelAccessTable,
  productsTable,
  type AcrJobRow,
} from "@workspace/db";
import { resolveAiClient, type ResolvedAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { logger } from "./logger";
import {
  aggregateAgentScores,
  allowanceFor,
  computeRedFlagImpacts,
  computeResponseMetrics,
  defaultConversationAiResult,
  formatWibTimestamp,
  gradeFor,
  missedChatToRawScore,
  normalizeCoachingAiResult,
  normalizeConversationAiResult,
  parseAiJson,
  periodToUtcRange,
  responseTimeToRawScore,
  type AcrConfigSnapshot,
  type AcrMessage,
  type ConversationAiResult,
  type ResponseMetrics,
} from "./acr-build";
import {
  ACR_SYSTEM_PROMPT_COACHING,
  ACR_SYSTEM_PROMPT_CONVERSATION,
  buildCoachingUserPrompt,
  buildConversationUserPrompt,
} from "./acr-prompts";

// ─── AI call with retry (max 2 retries, exponential backoff) ────────────────

async function callAiJson(
  resolved: ResolvedAiClient,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  channelId: number | null
): Promise<Record<string, unknown> | null> {
  const { client, model, provider, ownerUserId } = resolved;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const completion = (await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      })) as {
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      await recordAiUsage({
        ownerUserId,
        channelId,
        provider,
        model,
        usage: completion.usage ?? null,
      });
      const content = completion.choices?.[0]?.message?.content ?? "";
      const parsed = parseAiJson(content);
      if (parsed) return parsed;
      throw new Error("AI response was not valid JSON");
    } catch (err) {
      if (attempt === 2) {
        logger.error({ err }, "[acr] AI call failed after retries");
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
    }
  }
  return null;
}

// ─── Conversation discovery ─────────────────────────────────────────────────

interface AgentInfo {
  id: number;
  name: string | null;
  email: string;
  // 'super_admin' covers the tenant owner doing CS themselves (common for
  // small tenants and for testing).
  teamRole: "super_admin" | "supervisor" | "agent";
}

interface ConversationWork {
  chatId: number;
  contactName: string;
  channelId: number;
  channelType: string | null;
}

interface ConversationOutcome {
  chatId: number;
  contactName: string;
  channelId: number;
  channelType: string | null;
  metrics: ResponseMetrics;
  ai: ConversationAiResult;
  aiFailed: boolean;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  totalMessages: number;
  excerptForFlags: (messageIds: number[]) => string;
  lastInboundAt: Date | null;
  convScores: {
    responseTime: number;
    language: number;
    answer: number;
    complaint: number;
    missed: number;
    total: number;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const numStr = (n: number | null): string | null =>
  n == null ? null : n.toFixed(2);

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runAcrJob(jobId: string): Promise<void> {
  const job = await db.query.acrJobsTable.findFirst({
    where: eq(acrJobsTable.id, jobId),
  });
  if (!job) return;
  if (job.status === "running" || job.status === "completed") return;

  await db
    .update(acrJobsTable)
    .set({ status: "running", startedAt: new Date(), errorMessage: null })
    .where(eq(acrJobsTable.id, jobId));

  try {
    await executeJob(job);
  } catch (err) {
    logger.error({ err, jobId }, "[acr] job failed");
    await db
      .update(acrJobsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: String(err).slice(0, 1000),
      })
      .where(eq(acrJobsTable.id, jobId));
  }
}

async function executeJob(job: AcrJobRow): Promise<void> {
  const ownerUserId = job.ownerUserId;
  const cfg = job.configSnapshot as unknown as AcrConfigSnapshot;
  const { start, end } = periodToUtcRange(job.periodStart, job.periodEnd);

  // Tenant channels (id → kind).
  const channels = await db
    .select({ id: channelsTable.id, kind: channelsTable.kind })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));
  const channelKind = new Map(channels.map((c) => [c.id, c.kind]));
  const channelIds = channels.map((c) => c.id);

  // Evaluable team members: supervisors + agents under this owner, PLUS the
  // owner themselves — small tenants often have the owner doing CS directly.
  const memberRows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      teamRole: usersTable.teamRole,
    })
    .from(usersTable)
    .where(
      or(
        eq(usersTable.id, ownerUserId),
        and(
          eq(usersTable.parentUserId, ownerUserId),
          inArray(usersTable.teamRole, ["supervisor", "agent"])
        )
      )
    );
  const requestedIds =
    job.agentUserIds && job.agentUserIds.length > 0
      ? new Set(job.agentUserIds)
      : null;
  const members = new Map<number, AgentInfo>(
    memberRows
      .filter((m) => !requestedIds || requestedIds.has(m.id))
      .map((m) => [
        m.id,
        {
          id: m.id,
          name: m.name,
          email: m.email,
          teamRole:
            m.id === ownerUserId
              ? "super_admin"
              : m.teamRole === "supervisor"
                ? "supervisor"
                : "agent",
        },
      ])
  );

  if (channelIds.length === 0 || members.size === 0) {
    await db
      .update(acrJobsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(acrJobsTable.id, job.id));
    return;
  }

  // Conversations replied by a human in the period, attributed per message to
  // sent_by_user_id, falling back to chats.assigned_user_id, and finally to
  // the OWNER — historical rows predate the sent_by_user_id column, and in a
  // single-operator tenant every human outbound is effectively the owner's.
  // Group chats and status broadcasts are out of scope for CS evaluation.
  const outboundRows = await db
    .select({
      chatId: chatMessagesTable.chatId,
      author: sql<number | null>`COALESCE(${chatMessagesTable.sentByUserId}, ${chatsTable.assignedUserId}, ${ownerUserId})`,
      contactName: chatsTable.contactName,
      channelId: chatsTable.channelId,
      msgCount: sql<number>`count(*)::int`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, channelIds),
        eq(chatMessagesTable.direction, "outbound"),
        eq(chatMessagesTable.isAiGenerated, false),
        gte(chatMessagesTable.createdAt, start),
        lte(chatMessagesTable.createdAt, end),
        sql`${chatsTable.phoneNumber} NOT LIKE '%@g.us'`,
        sql`${chatsTable.phoneNumber} <> 'status@broadcast'`
      )
    )
    .groupBy(
      chatMessagesTable.chatId,
      sql`COALESCE(${chatMessagesTable.sentByUserId}, ${chatsTable.assignedUserId}, ${ownerUserId})`,
      chatsTable.contactName,
      chatsTable.channelId
    );

  // A chat counts once, for its primary responder (most human outbound
  // messages in the period). Authors outside the evaluated member set
  // (owner, removed users, unattributed rows) don't claim conversations.
  const byChat = new Map<
    number,
    { best: number; agentId: number; contactName: string; channelId: number }
  >();
  for (const row of outboundRows) {
    if (row.author == null || !members.has(row.author)) continue;
    const prev = byChat.get(row.chatId);
    if (!prev || row.msgCount > prev.best) {
      byChat.set(row.chatId, {
        best: row.msgCount,
        agentId: row.author,
        contactName: row.contactName,
        channelId: row.channelId,
      });
    }
  }

  const workByAgent = new Map<number, ConversationWork[]>();
  for (const [chatId, w] of byChat) {
    const list = workByAgent.get(w.agentId) ?? [];
    list.push({
      chatId,
      contactName: w.contactName,
      channelId: w.channelId,
      channelType: channelKind.get(w.channelId) ?? null,
    });
    workByAgent.set(w.agentId, list);
  }

  const progressTotal = [...workByAgent.values()].reduce((a, l) => a + l.length, 0);
  await db
    .update(acrJobsTable)
    .set({ progressTotal })
    .where(eq(acrJobsTable.id, job.id));

  if (progressTotal === 0) {
    await db
      .update(acrJobsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        totalAgentsEvaluated: 0,
      })
      .where(eq(acrJobsTable.id, job.id));
    return;
  }

  // Tenant context for the AI prompt.
  const [owner] = await db
    .select({ name: usersTable.name, companyName: usersTable.companyName })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);
  const products = await db
    .select({ name: productsTable.name })
    .from(productsTable)
    .where(eq(productsTable.userId, ownerUserId))
    .limit(10);
  const productCatalog =
    products.length > 0
      ? products.map((p) => p.name).join(", ").slice(0, 100)
      : null;
  const businessName = owner?.companyName || owner?.name || null;

  const resolvedAi = await resolveAiClient(ownerUserId);

  let totalConversations = 0;
  let totalMessages = 0;
  let aiCalls = 0;
  let aiFailures = 0;
  let progressCompleted = 0;

  // First pass: analyze every conversation, persist per-agent results.
  const agentTotals: Array<{
    scoreId: string;
    agentId: number;
    totalScore: number;
    avgRt: number | null;
  }> = [];

  for (const [agentId, work] of workByAgent) {
    const agent = members.get(agentId)!;
    const agentName = agent.name?.trim() || agent.email.split("@")[0] || "Agent";
    const outcomes: ConversationOutcome[] = [];

    for (const conv of work) {
      const rows = await db
        .select({
          id: chatMessagesTable.id,
          direction: chatMessagesTable.direction,
          isAiGenerated: chatMessagesTable.isAiGenerated,
          content: chatMessagesTable.content,
          createdAt: chatMessagesTable.createdAt,
        })
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.chatId, conv.chatId),
            gte(chatMessagesTable.createdAt, start),
            lte(chatMessagesTable.createdAt, end)
          )
        )
        .orderBy(chatMessagesTable.createdAt)
        .limit(500);

      const messages: AcrMessage[] = rows.map((r) => ({
        id: r.id,
        direction: r.direction === "outbound" ? "outbound" : "inbound",
        isAiGenerated: r.isAiGenerated,
        content: r.content,
        createdAt: r.createdAt,
      }));
      if (messages.length === 0) {
        progressCompleted++;
        continue;
      }

      const metrics = computeResponseMetrics(messages, cfg.slaCriticalMinutes);

      aiCalls++;
      const parsed = await callAiJson(
        resolvedAi,
        ACR_SYSTEM_PROMPT_CONVERSATION,
        buildConversationUserPrompt({
          agentName,
          agentRole: agent.teamRole,
          contactName: conv.contactName,
          channelType: conv.channelType,
          messages,
          avgResponseMinutes: metrics.avgResponseTimeMinutes,
          hasMissedMessage: metrics.missedTurns > 0,
          businessName,
          productCatalog,
        }),
        1000,
        conv.channelId
      );
      const aiFailed = parsed == null;
      if (aiFailed) aiFailures++;
      const ai = aiFailed
        ? defaultConversationAiResult()
        : normalizeConversationAiResult(parsed);

      const byId = new Map(messages.map((m) => [m.id, m]));
      const excerptForFlags = (ids: number[]): string =>
        ids
          .map((id) => byId.get(id))
          .filter((m): m is AcrMessage => !!m)
          .map(
            (m) =>
              `${m.direction === "inbound" ? "Customer" : "Agent"} [${formatWibTimestamp(
                m.createdAt
              ).slice(11)}]: ${(m.content || "[media]").slice(0, 120)}`
          )
          .join(" ")
          .slice(0, 500);

      const inbound = messages.filter((m) => m.direction === "inbound");

      // Per-conversation raw scores (0–100, pre-weighting).
      const convResponse = responseTimeToRawScore(metrics.avgResponseTimeMinutes, cfg);
      const convMissed = missedChatToRawScore(
        metrics.missedTurns,
        metrics.totalCustomerMessages
      );
      const convComplaint = ai.has_complaint ? ai.complaint_handling_score : 85;
      const convTotal = round2(
        (convResponse * cfg.weightResponseTime +
          ai.language_quality_score * cfg.weightLanguageQuality +
          ai.answer_quality_score * cfg.weightAnswerQuality +
          convComplaint * cfg.weightComplaintHandling +
          convMissed * cfg.weightMissedChat) /
          100
      );

      outcomes.push({
        chatId: conv.chatId,
        contactName: conv.contactName,
        channelId: conv.channelId,
        channelType: conv.channelType,
        metrics,
        ai,
        aiFailed,
        firstMessageAt: messages[0]!.createdAt,
        lastMessageAt: messages[messages.length - 1]!.createdAt,
        totalMessages: messages.length,
        excerptForFlags,
        lastInboundAt: inbound.length > 0 ? inbound[inbound.length - 1]!.createdAt : null,
        convScores: {
          responseTime: convResponse,
          language: ai.language_quality_score,
          answer: ai.answer_quality_score,
          complaint: convComplaint,
          missed: convMissed,
          total: convTotal,
        },
      });

      totalConversations++;
      totalMessages += messages.length;
      progressCompleted++;
      await db
        .update(acrJobsTable)
        .set({ progressCompleted })
        .where(eq(acrJobsTable.id, job.id));
    }

    if (outcomes.length === 0) continue;

    // ── Aggregate the agent (Section 4.5–4.8) ──
    const allResponseTimes = outcomes.flatMap((o) => o.metrics.responseTimesMinutes);
    const avgRt =
      allResponseTimes.length > 0
        ? allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
        : null;
    const totalMissed = outcomes.reduce((a, o) => a + o.metrics.missedTurns, 0);
    const totalCustomerMsgs = outcomes.reduce(
      (a, o) => a + o.metrics.totalCustomerMessages,
      0
    );
    const totalAgentMsgs = outcomes.reduce(
      (a, o) => a + o.metrics.totalAgentMessages,
      0
    );
    const complaintConvs = outcomes.filter((o) => o.ai.has_complaint);
    const avgOf = (vals: number[]): number | null =>
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

    const weighted = aggregateAgentScores(
      {
        rawResponseTimeScore: responseTimeToRawScore(avgRt, cfg),
        rawMissedChatScore: missedChatToRawScore(totalMissed, totalCustomerMsgs),
        rawLanguageScore: avgOf(outcomes.map((o) => o.convScores.language)),
        rawAnswerScore: avgOf(outcomes.map((o) => o.convScores.answer)),
        rawComplaintScore: avgOf(
          complaintConvs.map((o) => o.ai.complaint_handling_score)
        ),
      },
      cfg
    );
    const grade = gradeFor(weighted.totalScore, cfg);
    const allowance = allowanceFor(grade, cfg);

    const [scoreRow] = await db
      .insert(acrAgentScoresTable)
      .values({
        jobId: job.id,
        ownerUserId,
        agentUserId: agentId,
        agentName,
        agentEmail: agent.email,
        agentRole: agent.teamRole,
        totalScore: weighted.totalScore.toFixed(2),
        scoreResponseTime: weighted.scoreResponseTime.toFixed(2),
        scoreLanguageQuality: weighted.scoreLanguageQuality.toFixed(2),
        scoreAnswerQuality: weighted.scoreAnswerQuality.toFixed(2),
        scoreComplaintHandling: weighted.scoreComplaintHandling.toFixed(2),
        scoreMissedChat: weighted.scoreMissedChat.toFixed(2),
        avgResponseTimeMinutes: numStr(avgRt),
        totalConversations: outcomes.length,
        totalMessagesSent: totalAgentMsgs,
        totalMissedChats: totalMissed,
        totalComplaints: complaintConvs.length,
        complaintsResolved: complaintConvs.filter((o) => o.ai.complaint_resolved).length,
        insufficientData: outcomes.length < 5,
        grade,
        allowanceAmount: allowance,
      })
      .returning({ id: acrAgentScoresTable.id });
    const agentScoreId = scoreRow!.id;

    // ── Persist conversations + red flags ──
    type FlagDraft = {
      chatId: number;
      contactName: string;
      channelId: number;
      channelType: string | null;
      violationType: string;
      violationSeverity: string;
      aiExplanation: string;
      aiRecommendation: string | null;
      conversationExcerpt: string;
      occurredAt: Date | null;
    };
    const flagDrafts: FlagDraft[] = [];

    for (const o of outcomes) {
      const detFlags: Array<{ type: string }> = [];

      // Deterministic: customer_ignored (Section 4.3).
      for (const ev of o.metrics.customerIgnoredEvents) {
        detFlags.push({ type: "customer_ignored" });
        flagDrafts.push({
          chatId: o.chatId,
          contactName: o.contactName,
          channelId: o.channelId,
          channelType: o.channelType,
          violationType: "customer_ignored",
          violationSeverity: "high",
          aiExplanation: `Customer mengirim ${ev.repeatCount} pesan sebelum mendapat balasan pertama dari agent.`,
          aiRecommendation:
            "Balas pesan pertama customer secepatnya; bila sibuk, kirim pesan penahan agar customer tahu pesannya sudah dilihat.",
          conversationExcerpt: o.excerptForFlags(ev.turnMessageIds),
          occurredAt: ev.firstInboundAt,
        });
      }
      // Deterministic: no_reply_critical (Section 4.4).
      for (const ev of o.metrics.noReplyCriticalEvents) {
        detFlags.push({ type: "no_reply_critical" });
        flagDrafts.push({
          chatId: o.chatId,
          contactName: o.contactName,
          channelId: o.channelId,
          channelType: o.channelType,
          violationType: "no_reply_critical",
          violationSeverity: "critical",
          aiExplanation: `Pesan customer baru dibalas setelah ${Math.round(
            ev.minutes
          )} menit — melebihi ambang kritis ${cfg.slaCriticalMinutes} menit.`,
          aiRecommendation:
            "Atur notifikasi/jadwal pengecekan chat agar tidak ada pesan menunggu melewati ambang kritis.",
          conversationExcerpt: "",
          occurredAt: ev.firstInboundAt,
        });
      }
      // AI-detected flags.
      for (const f of o.ai.red_flags) {
        detFlags.push({ type: f.type });
        flagDrafts.push({
          chatId: o.chatId,
          contactName: o.contactName,
          channelId: o.channelId,
          channelType: o.channelType,
          violationType: f.type,
          violationSeverity: f.severity,
          aiExplanation: f.explanation || "Pelanggaran terdeteksi oleh AI.",
          aiRecommendation: f.recommendation || null,
          conversationExcerpt: f.excerpt,
          occurredAt: o.lastInboundAt ?? o.lastMessageAt,
        });
      }

      const flagTypes = [...new Set(detFlags.map((f) => f.type))];
      await db.insert(acrConversationScoresTable).values({
        jobId: job.id,
        agentScoreId,
        ownerUserId,
        agentUserId: agentId,
        chatId: o.chatId,
        contactName: o.contactName,
        channelId: o.channelId,
        channelType: o.channelType,
        firstMessageAt: o.firstMessageAt,
        lastMessageAt: o.lastMessageAt,
        totalMessages: o.totalMessages,
        agentMessages: o.metrics.totalAgentMessages,
        customerMessages: o.metrics.totalCustomerMessages,
        avgResponseTimeMinutes: numStr(o.metrics.avgResponseTimeMinutes),
        firstResponseTimeMinutes: numStr(o.metrics.firstResponseTimeMinutes),
        maxResponseTimeMinutes: numStr(o.metrics.maxResponseTimeMinutes),
        hasMissedMessage: o.metrics.missedTurns > 0,
        hasComplaint: o.ai.has_complaint,
        complaintResolved: o.ai.complaint_resolved,
        convScoreResponseTime: o.convScores.responseTime.toFixed(2),
        convScoreLanguageQuality: o.convScores.language.toFixed(2),
        convScoreAnswerQuality: o.convScores.answer.toFixed(2),
        convScoreComplaintHandling: o.convScores.complaint.toFixed(2),
        convScoreMissedChat: o.convScores.missed.toFixed(2),
        convTotalScore: o.convScores.total.toFixed(2),
        hasRedFlag: flagTypes.length > 0,
        redFlagTypes: flagTypes.length > 0 ? flagTypes : null,
        aiNotes: o.ai.ai_notes || null,
        answerCausedCustomerSilent: o.ai.answer_caused_customer_silent,
      });
    }

    if (flagDrafts.length > 0) {
      const impacts = computeRedFlagImpacts(
        flagDrafts.map((f) => ({ violationType: f.violationType })),
        weighted,
        cfg
      );
      await db.insert(acrRedFlagsTable).values(
        flagDrafts.map((f, idx) => ({
          jobId: job.id,
          agentScoreId,
          ownerUserId,
          agentUserId: agentId,
          agentName,
          chatId: f.chatId,
          contactName: f.contactName,
          channelId: f.channelId,
          channelType: f.channelType,
          conversationExcerpt: f.conversationExcerpt || null,
          violationType: f.violationType,
          violationSeverity: f.violationSeverity,
          aiExplanation: f.aiExplanation,
          aiRecommendation: f.aiRecommendation,
          scoreImpactDimension: impacts[idx]!.dimension,
          scoreImpactPoints: impacts[idx]!.points.toFixed(2),
          occurredAt: f.occurredAt,
          messageTimestamp: f.occurredAt,
        }))
      );
      await db
        .update(acrAgentScoresTable)
        .set({
          redFlagCount: flagDrafts.length,
          hasCriticalViolation: flagDrafts.some(
            (f) => f.violationSeverity === "critical"
          ),
        })
        .where(eq(acrAgentScoresTable.id, agentScoreId));
    }

    agentTotals.push({
      scoreId: agentScoreId,
      agentId,
      totalScore: weighted.totalScore,
      avgRt,
    });
  }

  // Fail the whole job when too many AI calls failed (Section 4.1).
  if (aiCalls > 0 && aiFailures / aiCalls > 0.2) {
    await db
      .update(acrJobsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        totalAgentsEvaluated: agentTotals.length,
        totalConversationsAnalyzed: totalConversations,
        totalMessagesAnalyzed: totalMessages,
        errorMessage: `Terlalu banyak analisa AI gagal (${aiFailures}/${aiCalls}).`,
      })
      .where(eq(acrJobsTable.id, job.id));
    return;
  }

  // ── Second pass: team stats + coaching insight per agent ──
  const teamAvgScore =
    agentTotals.length > 0
      ? round2(agentTotals.reduce((a, t) => a + t.totalScore, 0) / agentTotals.length)
      : 0;
  const rtVals = agentTotals.map((t) => t.avgRt).filter((v): v is number => v != null);
  const teamAvgRt =
    rtVals.length > 0
      ? round2(rtVals.reduce((a, b) => a + b, 0) / rtVals.length)
      : null;
  const ranked = [...agentTotals].sort((a, b) => b.totalScore - a.totalScore);
  const rankOf = new Map(ranked.map((t, i) => [t.agentId, i + 1]));

  for (const t of agentTotals) {
    try {
      await generateCoaching({
        job,
        cfg,
        agentScoreId: t.scoreId,
        teamAvgScore,
        teamAvgRt,
        rank: rankOf.get(t.agentId) ?? 1,
        totalAgents: agentTotals.length,
        resolvedAi,
      });
    } catch (err) {
      logger.error({ err, agentId: t.agentId }, "[acr] coaching generation failed");
    }
  }

  await db
    .update(acrJobsTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      totalAgentsEvaluated: agentTotals.length,
      totalConversationsAnalyzed: totalConversations,
      totalMessagesAnalyzed: totalMessages,
      progressCompleted: progressTotal,
    })
    .where(eq(acrJobsTable.id, job.id));

  // ── Red-flag notifications (Section 12) ──
  try {
    await sendRedFlagNotifications(job.id, ownerUserId, job.isAutoScheduled);
  } catch (err) {
    logger.error({ err, jobId: job.id }, "[acr] notification fan-out failed");
  }
}

// ─── Coaching insight (Section 5.2 / 5.4) ───────────────────────────────────

async function generateCoaching(opts: {
  job: AcrJobRow;
  cfg: AcrConfigSnapshot;
  agentScoreId: string;
  teamAvgScore: number;
  teamAvgRt: number | null;
  rank: number;
  totalAgents: number;
  resolvedAi: ResolvedAiClient;
}): Promise<void> {
  const { job, cfg, agentScoreId, teamAvgScore, teamAvgRt, rank, totalAgents } = opts;

  const score = await db.query.acrAgentScoresTable.findFirst({
    where: eq(acrAgentScoresTable.id, agentScoreId),
  });
  if (!score) return;

  const convs = await db
    .select()
    .from(acrConversationScoresTable)
    .where(eq(acrConversationScoresTable.agentScoreId, agentScoreId));
  const sortable = convs.filter((c) => c.convTotalScore != null);
  sortable.sort((a, b) => Number(a.convTotalScore) - Number(b.convTotalScore));
  const worst = sortable[0] ?? null;
  const best = sortable.length > 0 ? sortable[sortable.length - 1]! : null;

  const flagRows = await db
    .select({
      violationType: acrRedFlagsTable.violationType,
      count: sql<number>`count(*)::int`,
    })
    .from(acrRedFlagsTable)
    .where(eq(acrRedFlagsTable.agentScoreId, agentScoreId))
    .groupBy(acrRedFlagsTable.violationType);
  const redFlagCounts: Record<string, number> = {};
  for (const r of flagRows) redFlagCounts[r.violationType] = r.count;

  // Short excerpts from the actual transcripts (3–5 messages).
  const excerptFor = async (chatId: number | null): Promise<string> => {
    if (chatId == null) return "-";
    const { start, end } = periodToUtcRange(job.periodStart, job.periodEnd);
    const msgs = await db
      .select({
        direction: chatMessagesTable.direction,
        content: chatMessagesTable.content,
        createdAt: chatMessagesTable.createdAt,
      })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.chatId, chatId),
          gte(chatMessagesTable.createdAt, start),
          lte(chatMessagesTable.createdAt, end)
        )
      )
      .orderBy(chatMessagesTable.createdAt)
      .limit(200);
    return msgs
      .slice(-5)
      .map(
        (m) =>
          `${formatWibTimestamp(m.createdAt)} | ${
            m.direction === "inbound" ? "Customer" : "Agent"
          }: ${(m.content || "[media]").slice(0, 150)}`
      )
      .join("\n");
  };

  const parsed = await callAiJson(
    opts.resolvedAi,
    ACR_SYSTEM_PROMPT_COACHING,
    buildCoachingUserPrompt({
      agentName: score.agentName ?? "Agent",
      agentRole: score.agentRole,
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
      totalScore: Number(score.totalScore),
      grade: score.grade,
      scoreResponseTime: Number(score.scoreResponseTime),
      weightResponseTime: cfg.weightResponseTime,
      avgResponseTimeMinutes:
        score.avgResponseTimeMinutes != null
          ? Number(score.avgResponseTimeMinutes)
          : null,
      slaExcellentMinutes: cfg.slaExcellentMinutes,
      scoreLanguageQuality: Number(score.scoreLanguageQuality),
      weightLanguageQuality: cfg.weightLanguageQuality,
      scoreAnswerQuality: Number(score.scoreAnswerQuality),
      weightAnswerQuality: cfg.weightAnswerQuality,
      scoreComplaintHandling: Number(score.scoreComplaintHandling),
      weightComplaintHandling: cfg.weightComplaintHandling,
      totalComplaints: score.totalComplaints,
      complaintsResolved: score.complaintsResolved,
      scoreMissedChat: Number(score.scoreMissedChat),
      weightMissedChat: cfg.weightMissedChat,
      totalMissedChats: score.totalMissedChats,
      totalCustomerMessages: convs.reduce((a, c) => a + c.customerMessages, 0),
      teamAvgScore,
      agentRank: rank,
      totalAgents,
      teamAvgResponseMinutes: teamAvgRt,
      redFlagCounts,
      slaCriticalMinutes: cfg.slaCriticalMinutes,
      bestConversation: best
        ? {
            id: best.id,
            score: best.convTotalScore != null ? Number(best.convTotalScore) : null,
            avgResponseMinutes:
              best.avgResponseTimeMinutes != null
                ? Number(best.avgResponseTimeMinutes)
                : null,
            hasComplaint: best.hasComplaint,
            complaintResolved: best.complaintResolved,
            aiNotes: best.aiNotes,
            excerpt: await excerptFor(best.chatId),
          }
        : null,
      worstConversation: worst
        ? {
            id: worst.id,
            score: worst.convTotalScore != null ? Number(worst.convTotalScore) : null,
            avgResponseMinutes:
              worst.avgResponseTimeMinutes != null
                ? Number(worst.avgResponseTimeMinutes)
                : null,
            hasComplaint: worst.hasComplaint,
            complaintResolved: worst.complaintResolved,
            redFlagTypes: worst.redFlagTypes ?? [],
            aiNotes: worst.aiNotes,
            excerpt: await excerptFor(worst.chatId),
          }
        : null,
    }),
    1500,
    null
  );
  if (!parsed) return;

  const coaching = normalizeCoachingAiResult(parsed);
  await db
    .update(acrAgentScoresTable)
    .set({
      aiSummary: coaching.ai_summary || null,
      aiStrengths: coaching.ai_strengths || null,
      aiImprovements: coaching.ai_improvements || null,
      coachingInsights: {
        top_improvements: coaching.top_improvements,
        best_conversation_id: coaching.best_conversation_id ?? best?.id ?? null,
        worst_conversation_id: coaching.worst_conversation_id ?? worst?.id ?? null,
        best_conversation_excerpt: coaching.best_conversation_excerpt,
        worst_conversation_excerpt: coaching.worst_conversation_excerpt,
        worst_conversation_annotation: coaching.worst_conversation_annotation,
        team_comparison: {
          avg_response_time_team: teamAvgRt ?? 0,
          avg_score_team: teamAvgScore,
          agent_rank: rank,
          total_agents: totalAgents,
        },
      },
    })
    .where(eq(acrAgentScoresTable.id, agentScoreId));
}

// ─── Notifications (Section 12) ─────────────────────────────────────────────

// Super_admin gets every red flag; supervisors only the flags on channels
// they can access (user_channel_access). The flagged agent never receives
// notifications about their own flags here — they see them in their drawer.
async function sendRedFlagNotifications(
  jobId: string,
  ownerUserId: number,
  isAutoScheduled: boolean
): Promise<void> {
  const flags = await db
    .select({
      id: acrRedFlagsTable.id,
      channelId: acrRedFlagsTable.channelId,
      agentUserId: acrRedFlagsTable.agentUserId,
    })
    .from(acrRedFlagsTable)
    .where(eq(acrRedFlagsTable.jobId, jobId));
  if (flags.length === 0 && !isAutoScheduled) return;

  const supervisors = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.parentUserId, ownerUserId),
        eq(usersTable.teamRole, "supervisor"),
        eq(usersTable.status, "active")
      )
    );
  const supervisorIds = supervisors.map((s) => s.id);
  const access = supervisorIds.length
    ? await db
        .select({
          userId: userChannelAccessTable.userId,
          channelId: userChannelAccessTable.channelId,
        })
        .from(userChannelAccessTable)
        .where(inArray(userChannelAccessTable.userId, supervisorIds))
    : [];
  const supervisorChannels = new Map<number, Set<number>>();
  for (const a of access) {
    const set = supervisorChannels.get(a.userId) ?? new Set<number>();
    set.add(a.channelId);
    supervisorChannels.set(a.userId, set);
  }

  const values: Array<typeof acrNotificationsTable.$inferInsert> = [];
  for (const flag of flags) {
    values.push({
      ownerUserId,
      recipientUserId: ownerUserId,
      redFlagId: flag.id,
      jobId,
    });
    for (const supId of supervisorIds) {
      if (supId === flag.agentUserId) continue;
      const chans = supervisorChannels.get(supId);
      if (flag.channelId != null && chans?.has(flag.channelId)) {
        values.push({
          ownerUserId,
          recipientUserId: supId,
          redFlagId: flag.id,
          jobId,
        });
      }
    }
  }
  if (values.length > 0) {
    await db.insert(acrNotificationsTable).values(values);
  }
}

// ─── Auto-schedule completion notifications (Section 13) ────────────────────

export async function sendAutoScheduleNotifications(
  jobId: string,
  ownerUserId: number,
  notifyUserIds: number[]
): Promise<void> {
  if (notifyUserIds.length === 0) return;
  // Verify recipients still belong to the tenant before notifying.
  const valid = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        inArray(usersTable.id, notifyUserIds),
        or(eq(usersTable.id, ownerUserId), eq(usersTable.parentUserId, ownerUserId)),
        eq(usersTable.status, "active")
      )
    );
  if (valid.length === 0) return;
  await db.insert(acrNotificationsTable).values(
    valid.map((u) => ({
      ownerUserId,
      recipientUserId: u.id,
      jobId,
      redFlagId: null,
    }))
  );
}
