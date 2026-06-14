// AI Chat Report — asynchronous job runner (Section 4–5 of the ACR spec).
//
// Flow per job: discover agents (human outbound authors in the period) →
// per conversation compute deterministic metrics + 1 AI quality call →
// aggregate per agent → 1 coaching AI call per agent → leaderboard stats →
// red-flag notifications. All calculations use the job's immutable
// config_snapshot, never the live config.

import { and, eq, gte, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  acrJobsTable,
  acrAgentScoresTable,
  acrConversationScoresTable,
  acrRedFlagsTable,
  acrNotificationsTable,
  acrKpiSnapshotsTable,
  acrSchedulesTable,
  acrAgentTargetsTable,
  acrAchievementsTable,
  acrPerformanceAlertsTable,
  chatsTable,
  chatMessagesTable,
  channelsTable,
  contactLabelsTable,
  usersTable,
  userChannelAccessTable,
  productsTable,
  type AcrJobRow,
} from "@workspace/db";
import { resolveAiClient, type ResolvedAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { buildAcrPdf } from "./acr-pdf";
import { saveTenantMedia } from "./tenant-storage";
import { logger } from "./logger";
import {
  aggregateAgentScores,
  allowanceFor,
  computeRedFlagImpacts,
  computeResponseMetrics,
  defaultConversationAiResult,
  formatWibTimestamp,
  gradeFor,
  isHumanMessage,
  missedChatToRawScore,
  normalizeCoachingAiResult,
  normalizeConversationAiResult,
  parseAiJson,
  periodToUtcRange,
  responseTimeToRawScore,
  weightedTotalScore,
  buildPeriodLabel,
  type ScheduleFrequency,
  type AcrConfigSnapshot,
  type AcrMessage,
  type ConversationAiResult,
  type ResponseMetrics,
} from "./acr-build";
import {
  ACR_SYSTEM_PROMPT_COACHING,
  ACR_SYSTEM_PROMPT_CONVERSATION,
  ACR_SYSTEM_PROMPT_ALERT,
  ACR_SYSTEM_PROMPT_ACHIEVEMENT,
  ACR_SYSTEM_PROMPT_MOM,
  ACR_SYSTEM_PROMPT_BENCHMARK,
  buildCoachingUserPrompt,
  buildConversationUserPrompt,
  buildAlertUserPrompt,
  buildAchievementUserPrompt,
  buildMomUserPrompt,
  buildBenchmarkUserPrompt,
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
  const allChannelIds = channels.map((c) => c.id);
  // Apply the per-job channel filter (intersect with the tenant's channels).
  // Empty/null = all channels.
  const channelIds =
    job.channelIds && job.channelIds.length > 0
      ? allChannelIds.filter((id) => job.channelIds!.includes(id))
      : allChannelIds;

  // Evaluable team members: supervisors + agents under this owner. The owner
  // themselves is included only when the toggle says so (solo-CS tenants /
  // testing). The per-job override wins; null falls back to the config
  // snapshot — snapshot-controlled, so re-runs stay consistent.
  const includeOwner =
    job.includeOwner ?? cfg.includeOwnerInEvaluation === true;
  const memberWhere = and(
    eq(usersTable.parentUserId, ownerUserId),
    inArray(usersTable.teamRole, ["supervisor", "agent"])
  );
  const memberRows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      teamRole: usersTable.teamRole,
    })
    .from(usersTable)
    .where(includeOwner ? or(eq(usersTable.id, ownerUserId), memberWhere) : memberWhere);
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
  // sent_by_user_id, falling back to chats.assigned_user_id, then the
  // channel's penanggung jawab (channels.pic_user_id), and finally to the
  // OWNER — replies typed on the phone (and historical pre-column rows) carry
  // no sent_by_user_id, so the channel PIC / owner absorbs their KPI.
  // Group chats and status broadcasts are out of scope for CS evaluation.
  // Group by the raw columns and resolve the author fallback chain in JS —
  // a parameterised COALESCE in both SELECT and GROUP BY binds as two
  // different placeholders, which Postgres rejects as a non-grouped column.
  // Per-job chat filters (AND together; null/empty = no restriction). Lead
  // status restricts only when the job carries an explicit selection — empty/
  // null evaluates every chat regardless of lead classification, since CS-KPI
  // is orthogonal to the sales funnel and most tenants never classify leads.
  const chatFilters = [];
  if (job.leadStatuses && job.leadStatuses.length > 0) {
    chatFilters.push(inArray(chatsTable.leadStatus, job.leadStatuses));
  }
  if (job.chatStatuses && job.chatStatuses.length > 0) {
    chatFilters.push(inArray(chatsTable.status, job.chatStatuses));
  }
  if (job.customerLabelIds && job.customerLabelIds.length > 0) {
    chatFilters.push(
      inArray(
        chatsTable.phoneNumber,
        db
          .select({ phoneNumber: contactLabelsTable.phoneNumber })
          .from(contactLabelsTable)
          .where(
            and(
              eq(contactLabelsTable.ownerUserId, ownerUserId),
              inArray(contactLabelsTable.labelId, job.customerLabelIds)
            )
          )
      )
    );
  }

  const outboundRows = await db
    .select({
      chatId: chatMessagesTable.chatId,
      sentByUserId: chatMessagesTable.sentByUserId,
      assignedUserId: chatsTable.assignedUserId,
      channelPicUserId: channelsTable.picUserId,
      contactName: chatsTable.contactName,
      channelId: chatsTable.channelId,
      msgCount: sql<number>`count(*)::int`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .innerJoin(channelsTable, eq(chatsTable.channelId, channelsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, channelIds),
        eq(chatMessagesTable.direction, "outbound"),
        eq(chatMessagesTable.isAiGenerated, false),
        // Human-authored only (Section 4.1/4.1a). Mirror isHumanMessage: a
        // dashboard send sets sentByUserId; a reply typed on the phone has a
        // null sentByUserId AND no automated signature. Automated bot-flow /
        // follow-up sends carry a tag (_Chatbot_ / _follow-up otomatis_, plus
        // _powered by AI_ for the rare non-isAiGenerated case) and are
        // excluded. COALESCE so a null-content media reply counts as human.
        or(
          isNotNull(chatMessagesTable.sentByUserId),
          sql`COALESCE(${chatMessagesTable.content}, '') !~ '_(Chatbot|powered by AI|follow-up otomatis)_[[:space:]]*$'`
        ),
        gte(chatMessagesTable.createdAt, start),
        lte(chatMessagesTable.createdAt, end),
        sql`${chatsTable.phoneNumber} NOT LIKE '%@g.us'`,
        sql`${chatsTable.phoneNumber} <> 'status@broadcast'`,
        ...chatFilters
      )
    )
    .groupBy(
      chatMessagesTable.chatId,
      chatMessagesTable.sentByUserId,
      chatsTable.assignedUserId,
      channelsTable.picUserId,
      chatsTable.contactName,
      chatsTable.channelId
    );

  // A chat counts once, for its primary responder (most human outbound
  // messages in the period). Authors outside the evaluated member set
  // (removed users, filtered-out agents) don't claim conversations. Rows are
  // grouped per raw column pair, so sum counts per resolved author first.
  const countByChatAuthor = new Map<
    string,
    { chatId: number; agentId: number; count: number; contactName: string; channelId: number }
  >();
  for (const row of outboundRows) {
    // Attribution chain, most-specific → least-specific (Section 4.1):
    //   1. sentByUserId   — the individual who actually replied (dashboard).
    //   2. assignedUserId — the agent this chat is assigned to.
    //   3. channelPicUserId — the channel's penanggung jawab (KPI for replies
    //      typed on the phone, which carry no per-message author).
    //   4. ownerUserId    — tenant owner, last resort.
    const author =
      row.sentByUserId ??
      row.assignedUserId ??
      row.channelPicUserId ??
      ownerUserId;
    if (!members.has(author)) continue;
    const key = `${row.chatId}|${author}`;
    const prev = countByChatAuthor.get(key);
    if (prev) {
      prev.count += row.msgCount;
    } else {
      countByChatAuthor.set(key, {
        chatId: row.chatId,
        agentId: author,
        count: row.msgCount,
        contactName: row.contactName,
        channelId: row.channelId,
      });
    }
  }
  const byChat = new Map<
    number,
    { best: number; agentId: number; contactName: string; channelId: number }
  >();
  for (const entry of countByChatAuthor.values()) {
    const prev = byChat.get(entry.chatId);
    if (!prev || entry.count > prev.best) {
      byChat.set(entry.chatId, {
        best: entry.count,
        agentId: entry.agentId,
        contactName: entry.contactName,
        channelId: entry.channelId,
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
          sentByUserId: chatMessagesTable.sentByUserId,
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

      // Fetch ALL messages (inbound + AI/bot + human) so the AI sees full
      // context, but only human messages count toward KPIs (sentByUserId).
      const messages: AcrMessage[] = rows.map((r) => ({
        id: r.id,
        direction: r.direction === "outbound" ? "outbound" : "inbound",
        isAiGenerated: r.isAiGenerated,
        sentByUserId: r.sentByUserId,
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
              `${
                m.direction === "inbound" ? "CUSTOMER" : isHumanMessage(m) ? "AGENT" : "SISTEM"
              } [${formatWibTimestamp(m.createdAt).slice(11)}]: ${(m.content || "[media]").slice(
                0,
                120
              )}`
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
      // Honors complaintHandlingEnabled (redistributes the complaint weight
      // when off) so the per-conversation total matches the per-agent total.
      const convTotal = weightedTotalScore(
        {
          responseTime: convResponse,
          language: ai.language_quality_score,
          answer: ai.answer_quality_score,
          complaint: convComplaint,
          missed: convMissed,
        },
        cfg
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

  // ── KPI snapshot for the Dashboard (Bagian II) — manual & scheduled jobs ──
  try {
    await fillKpiSnapshot(job.id);
  } catch (err) {
    logger.error({ err, jobId: job.id }, "[acr] KPI snapshot fill failed");
  }

  // ── Red-flag notifications (Section 12) ──
  try {
    await sendRedFlagNotifications(job.id, ownerUserId, job.isAutoScheduled);
  } catch (err) {
    logger.error({ err, jobId: job.id }, "[acr] notification fan-out failed");
  }

  // ── Advanced analytics (Bagian IV): performance alerts + achievements ──
  try {
    await runPostJobAnalytics(job.id);
  } catch (err) {
    logger.error({ err, jobId: job.id }, "[acr] post-job analytics failed");
  }
}

// Pre-aggregate team KPIs for a completed job into acr_kpi_snapshots so the
// Dashboard (Bagian III) reads fast. Idempotent: upsert on job_id. Reads the
// persisted agent-score + red-flag rows (source of truth) rather than in-memory
// state, so a re-run recomputes cleanly.
async function fillKpiSnapshot(jobId: string): Promise<void> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job) return;

  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId));

  const num = (s: string | null): number => (s == null ? 0 : Number(s));
  const avg = (vals: number[]): number =>
    vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const r2 = (x: number): string => (Math.round(x * 100) / 100).toFixed(2);
  const n = scores.length;

  const rtVals = scores
    .map((s) => s.avgResponseTimeMinutes)
    .filter((v): v is string => v != null)
    .map(Number);

  const ranked = [...scores].sort((a, b) => num(b.totalScore) - num(a.totalScore));
  const top = ranked[0];
  const bot = ranked[ranked.length - 1];

  // Red-flag counts by type.
  const rf = await db
    .select({
      type: acrRedFlagsTable.violationType,
      c: sql<number>`count(*)::int`,
    })
    .from(acrRedFlagsTable)
    .where(eq(acrRedFlagsTable.jobId, jobId))
    .groupBy(acrRedFlagsTable.violationType);
  const rfCount = (t: string): number => rf.find((r) => r.type === t)?.c ?? 0;
  const totalRedFlags = rf.reduce((a, r) => a + r.c, 0);

  // Frequency / period label.
  let frequency: ScheduleFrequency | "manual" = "manual";
  if (job.scheduleId) {
    const sched = await db.query.acrSchedulesTable.findFirst({
      where: eq(acrSchedulesTable.id, job.scheduleId),
    });
    if (sched) frequency = sched.frequency as ScheduleFrequency;
  }
  const periodLabel = buildPeriodLabel(frequency, job.periodStart, job.periodEnd);

  const values = {
    jobId,
    ownerUserId: job.ownerUserId,
    scheduleId: job.scheduleId,
    periodStart: job.periodStart,
    periodEnd: job.periodEnd,
    periodLabel,
    jobType: job.jobType,
    frequency: frequency === "manual" ? null : frequency,
    teamAvgScore: n > 0 ? r2(avg(scores.map((s) => num(s.totalScore)))) : null,
    teamAvgResponseTime: rtVals.length > 0 ? r2(avg(rtVals)) : null,
    teamAvgLanguage: n > 0 ? r2(avg(scores.map((s) => num(s.scoreLanguageQuality)))) : null,
    teamAvgAnswer: n > 0 ? r2(avg(scores.map((s) => num(s.scoreAnswerQuality)))) : null,
    teamAvgComplaint: n > 0 ? r2(avg(scores.map((s) => num(s.scoreComplaintHandling)))) : null,
    teamAvgMissed: n > 0 ? r2(avg(scores.map((s) => num(s.scoreMissedChat)))) : null,
    countGradeA: scores.filter((s) => s.grade === "A").length,
    countGradeB: scores.filter((s) => s.grade === "B").length,
    countGradeC: scores.filter((s) => s.grade === "C").length,
    countGradeD: scores.filter((s) => s.grade === "D").length,
    countGradeE: scores.filter((s) => s.grade === "E").length,
    totalAgents: n,
    totalRedFlags,
    totalCustomerAngry: rfCount("customer_angry"),
    totalRudeLanguage: rfCount("rude_language"),
    totalNoReplyCritical: rfCount("no_reply_critical"),
    totalCustomerIgnored: rfCount("customer_ignored"),
    totalAnswerDropout: rfCount("answer_caused_dropout"),
    totalConversations: scores.reduce((a, s) => a + s.totalConversations, 0),
    totalMessages: scores.reduce((a, s) => a + s.totalMessagesSent, 0),
    totalMissedChats: scores.reduce((a, s) => a + s.totalMissedChats, 0),
    totalComplaints: scores.reduce((a, s) => a + s.totalComplaints, 0),
    complaintsResolved: scores.reduce((a, s) => a + s.complaintsResolved, 0),
    topPerformerName: top?.agentName ?? null,
    topPerformerScore: top ? r2(num(top.totalScore)) : null,
    topPerformerGrade: top?.grade ?? null,
    botPerformerName: bot?.agentName ?? null,
    botPerformerScore: bot ? r2(num(bot.totalScore)) : null,
    botPerformerGrade: bot?.grade ?? null,
    totalAllowanceAmount: scores.reduce((a, s) => a + (s.allowanceAmount ?? 0), 0),
  };

  await db
    .insert(acrKpiSnapshotsTable)
    .values(values)
    .onConflictDoUpdate({ target: acrKpiSnapshotsTable.jobId, set: values });
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

// Build a report PDF and persist it to tenant object storage, recording the
// URL on the job (Bagian II "full" — auto-gen after scheduled jobs). Idempotent
// enough: re-running simply stores a fresh object and overwrites pdf_path.
export async function generateAndStoreJobPdf(jobId: string): Promise<string | null> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job || job.status !== "completed") return null;

  const agents = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId))
    .orderBy(sql`${acrAgentScoresTable.totalScore} desc`);
  const agentIds = agents.map((a) => a.agentUserId);
  const redFlags =
    agentIds.length > 0
      ? await db
          .select()
          .from(acrRedFlagsTable)
          .where(eq(acrRedFlagsTable.jobId, jobId))
      : [];

  const [owner] = await db
    .select({ name: usersTable.name, companyName: usersTable.companyName })
    .from(usersTable)
    .where(eq(usersTable.id, job.ownerUserId))
    .limit(1);

  const pdf = await buildAcrPdf({
    job,
    agents,
    redFlags,
    businessName: owner?.companyName || owner?.name || "MaxiChat",
    generatedByName: "Otomatis (terjadwal)",
    includeRedFlags: true,
    includeCoaching: false,
  });

  const saved = await saveTenantMedia({
    ownerUserId: job.ownerUserId,
    buffer: Buffer.from(pdf),
    contentType: "application/pdf",
    kind: "acr-report",
    preferredFilename: `acr-${job.periodStart}_${job.periodEnd}.pdf`,
  });

  await db
    .update(acrJobsTable)
    .set({ pdfPath: saved.url, pdfGeneratedAt: new Date() })
    .where(eq(acrJobsTable.id, jobId));
  return saved.url;
}

// ─── Post-job analytics (Bagian IV 9.1/9.2/9.6) ─────────────────────────────
// After a job completes, detect performance-decline alerts (prompt 3) and new
// achievements (prompt 6) per agent. Additive + best-effort: AI failure for one
// agent never blocks the rest. Alerts need >=2 periods of history; achievements
// can trigger on the first period.
export async function runPostJobAnalytics(jobId: string): Promise<void> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job || job.status !== "completed") return;
  const ownerUserId = job.ownerUserId;

  const current = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId));
  if (current.length === 0) return;

  const resolvedAi = await resolveAiClient(ownerUserId);
  const N = (v: string | null): number => (v == null ? 0 : Number(v));

  // Frequency of the current job (for the achievement prompt).
  let frequency: ScheduleFrequency | "manual" = "manual";
  if (job.scheduleId) {
    const sched = await db.query.acrSchedulesTable.findFirst({
      where: eq(acrSchedulesTable.id, job.scheduleId),
    });
    if (sched) frequency = sched.frequency as ScheduleFrequency;
  }
  const currentLabel = buildPeriodLabel(frequency, job.periodStart, job.periodEnd);
  const langMax = Number((job.configSnapshot as Record<string, unknown>).weightLanguageQuality ?? 25);

  // Recent completed jobs (incl. current), newest first → chronological.
  const recentJobs = await db
    .select({
      id: acrJobsTable.id,
      periodStart: acrJobsTable.periodStart,
      periodEnd: acrJobsTable.periodEnd,
      scheduleId: acrJobsTable.scheduleId,
    })
    .from(acrJobsTable)
    .where(
      and(
        eq(acrJobsTable.ownerUserId, ownerUserId),
        eq(acrJobsTable.status, "completed"),
        isNull(acrJobsTable.archivedAt)
      )
    )
    .orderBy(sql`${acrJobsTable.periodStart} desc`, sql`${acrJobsTable.createdAt} desc`)
    .limit(6);
  const chrono = [...recentJobs].reverse(); // oldest → newest
  const jobIds = chrono.map((j) => j.id);

  // Period labels from snapshots (fall back to date range).
  const snaps = await db
    .select({ jobId: acrKpiSnapshotsTable.jobId, label: acrKpiSnapshotsTable.periodLabel })
    .from(acrKpiSnapshotsTable)
    .where(inArray(acrKpiSnapshotsTable.jobId, jobIds));
  const labelByJob = new Map(snaps.map((s) => [s.jobId, s.label]));
  const labelFor = (jid: string): string => {
    const m = chrono.find((j) => j.id === jid)!;
    return labelByJob.get(jid) ?? `${m.periodStart}..${m.periodEnd}`;
  };

  // Agent scores + red-flag counts across those jobs.
  const histScores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(inArray(acrAgentScoresTable.jobId, jobIds));
  const scoreByJobAgent = new Map<string, (typeof histScores)[number]>();
  for (const s of histScores) scoreByJobAgent.set(`${s.jobId}:${s.agentUserId}`, s);

  const rfRows = await db
    .select({
      jobId: acrRedFlagsTable.jobId,
      agentUserId: acrRedFlagsTable.agentUserId,
      type: acrRedFlagsTable.violationType,
      c: sql<number>`count(*)::int`,
    })
    .from(acrRedFlagsTable)
    .where(inArray(acrRedFlagsTable.jobId, jobIds))
    .groupBy(acrRedFlagsTable.jobId, acrRedFlagsTable.agentUserId, acrRedFlagsTable.violationType);
  const rfByJobAgent = new Map<string, Record<string, number>>();
  for (const r of rfRows) {
    const k = `${r.jobId}:${r.agentUserId}`;
    const m = rfByJobAgent.get(k) ?? {};
    m[r.type] = r.c;
    rfByJobAgent.set(k, m);
  }

  // Rank + per-agent delta vs the agent's previous appearance.
  const ranked = [...current].sort((a, b) => N(b.totalScore) - N(a.totalScore));
  const rankOf = new Map(ranked.map((s, i) => [s.agentUserId, i + 1]));
  const prevJobId = chrono.length >= 2 ? chrono[chrono.length - 2]!.id : null;
  const deltaOf = (agentId: number, total: number): number | null => {
    if (!prevJobId) return null;
    const prev = scoreByJobAgent.get(`${prevJobId}:${agentId}`);
    return prev ? total - N(prev.totalScore) : null;
  };
  let mostImprovedAgent: number | null = null;
  let mostImprovedDelta = -Infinity;
  for (const s of current) {
    const d = deltaOf(s.agentUserId, N(s.totalScore));
    if (d != null && d > mostImprovedDelta) {
      mostImprovedDelta = d;
      mostImprovedAgent = s.agentUserId;
    }
  }

  const targets = await db
    .select()
    .from(acrAgentTargetsTable)
    .where(eq(acrAgentTargetsTable.ownerUserId, ownerUserId));
  const targetByAgent = new Map(targets.map((t) => [t.agentUserId, Number(t.targetScore)]));

  for (const s of current) {
    const agentId = s.agentUserId;
    const total = N(s.totalScore);
    // The agent's own chronological history.
    const hist = chrono
      .map((j) => ({ jid: j.id, row: scoreByJobAgent.get(`${j.id}:${agentId}`) }))
      .filter((h) => h.row);
    const histLines = hist
      .map((h) => {
        const r = h.row!;
        return `${labelFor(h.jid)} | ${N(r.totalScore)} | ${r.grade} | ${N(r.scoreResponseTime)} | ${N(r.scoreLanguageQuality)} | ${N(r.scoreAnswerQuality)} | ${N(r.scoreComplaintHandling)} | ${N(r.scoreMissedChat)}`;
      })
      .join("\n");
    const rfLines = hist
      .map((h) => {
        const m = rfByJobAgent.get(`${h.jid}:${agentId}`) ?? {};
        const t = Object.values(m).reduce((a, b) => a + b, 0);
        return `${labelFor(h.jid)} | ${t} | ${m.customer_angry ?? 0} | ${m.rude_language ?? 0} | ${m.no_reply_critical ?? 0} | ${m.customer_ignored ?? 0} | ${m.answer_caused_dropout ?? 0}`;
      })
      .join("\n");
    const prevTotal =
      hist.length >= 2 ? N(hist[hist.length - 2]!.row!.totalScore) : null;

    // ── Alerts (need >=2 periods to compare). ──
    if (hist.length >= 2) {
      try {
        const parsed = await callAiJson(
          resolvedAi,
          ACR_SYSTEM_PROMPT_ALERT,
          buildAlertUserPrompt({
            agentName: s.agentName ?? `#${agentId}`,
            role: s.agentRole,
            targetScore: targetByAgent.get(agentId) ?? null,
            historyBlock: histLines,
            redFlagBlock: rfLines,
            latestLabel: currentLabel,
            latestScore: total,
            prevScore: prevTotal,
          }),
          800,
          null
        );
        const alerts = Array.isArray(parsed?.alerts) ? (parsed!.alerts as Record<string, unknown>[]) : [];
        if (parsed?.has_alert === true && alerts.length > 0) {
          await db.insert(acrPerformanceAlertsTable).values(
            alerts.map((a) => ({
              ownerUserId,
              agentUserId: agentId,
              jobId,
              alertType: String(a.alert_type ?? "score_drop_significant"),
              severity: String(a.severity ?? "medium"),
              title: String(a.title ?? "Penurunan performa").slice(0, 120),
              description: a.description ? String(a.description).slice(0, 400) : null,
              recommendation: a.recommendation ? String(a.recommendation).slice(0, 400) : null,
              affectedDimensions: Array.isArray(a.affected_dimensions)
                ? (a.affected_dimensions as unknown[]).map(String)
                : null,
            }))
          );
        }
      } catch (err) {
        logger.error({ err, agentId }, "[acr] alert detection failed");
      }
    }

    // ── Achievements (can trigger on first period). ──
    try {
      const existing = await db
        .selectDistinct({ achievementId: acrAchievementsTable.achievementId })
        .from(acrAchievementsTable)
        .where(
          and(
            eq(acrAchievementsTable.ownerUserId, ownerUserId),
            eq(acrAchievementsTable.agentUserId, agentId)
          )
        );
      const gradeHistory = hist
        .map((h) => `${labelFor(h.jid)} | ${h.row!.grade} | ${N(h.row!.totalScore)}`)
        .join("\n");
      const parsed = await callAiJson(
        resolvedAi,
        ACR_SYSTEM_PROMPT_ACHIEVEMENT,
        buildAchievementUserPrompt({
          agentName: s.agentName ?? `#${agentId}`,
          periodLabel: currentLabel,
          totalScore: total,
          grade: s.grade,
          avgRt: s.avgResponseTimeMinutes == null ? null : Number(s.avgResponseTimeMinutes),
          languageScore: N(s.scoreLanguageQuality),
          languageMax: langMax,
          totalRedFlags: s.redFlagCount,
          missedCount: s.totalMissedChats,
          totalComplaints: s.totalComplaints,
          complaintsResolved: s.complaintsResolved,
          rank: rankOf.get(agentId) ?? 1,
          totalAgents: current.length,
          mostImproved: mostImprovedAgent === agentId,
          improvedDelta: mostImprovedAgent === agentId ? Math.round(mostImprovedDelta) : null,
          frequency,
          gradeHistoryBlock: gradeHistory,
          existingAchievementIds: existing.map((e) => e.achievementId),
        }),
        600,
        null
      );
      const newAch = Array.isArray(parsed?.new_achievements)
        ? (parsed!.new_achievements as Record<string, unknown>[])
        : [];
      if (newAch.length > 0) {
        await db
          .insert(acrAchievementsTable)
          .values(
            newAch.map((a) => ({
              ownerUserId,
              agentUserId: agentId,
              jobId,
              achievementId: String(a.achievement_id ?? "unknown"),
              achievementName: String(a.achievement_name ?? "Pencapaian"),
              achievementIcon: String(a.achievement_icon ?? "🏅"),
              description: a.description ? String(a.description).slice(0, 120) : null,
              earnedAtPeriod: String(a.earned_at_period ?? currentLabel),
            }))
          )
          .onConflictDoNothing();
      }
    } catch (err) {
      logger.error({ err, agentId }, "[acr] achievement detection failed");
    }
  }
}

// ─── On-demand AI analysis (Bagian IV 9.5 MoM / 9.3 benchmark) ──────────────

const NSTR = (v: string | null): number => (v == null ? 0 : Number(v));

async function buildMomPeriodBlock(
  ownerUserId: number,
  jobId: string
): Promise<{ label: string; block: string } | null> {
  const snap = await db.query.acrKpiSnapshotsTable.findFirst({
    where: and(eq(acrKpiSnapshotsTable.jobId, jobId), eq(acrKpiSnapshotsTable.ownerUserId, ownerUserId)),
  });
  if (!snap) return null;
  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId))
    .orderBy(sql`${acrAgentScoresTable.totalScore} desc`);
  const agentLines = scores
    .map(
      (s) =>
        `${s.agentName ?? `#${s.agentUserId}`} | ${s.grade} | ${NSTR(s.totalScore)} | ${NSTR(s.scoreResponseTime)} | ${NSTR(s.scoreLanguageQuality)} | ${NSTR(s.scoreAnswerQuality)} | ${NSTR(s.scoreComplaintHandling)} | ${s.totalMissedChats}`
    )
    .join("\n");
  const block = `Rata-rata skor tim      : ${NSTR(snap.teamAvgScore)}
Avg waktu balas         : ${NSTR(snap.teamAvgResponseTime)} menit
Chat tidak terjawab     : ${snap.totalMissedChats}
Total red flag          : ${snap.totalRedFlags}
  - Customer marah      : ${snap.totalCustomerAngry}
  - Bahasa tidak sopan  : ${snap.totalRudeLanguage}
  - Chat dicuekin       : ${snap.totalCustomerIgnored}
  - Tidak dibalas       : ${snap.totalNoReplyCritical}
  - Jawaban dropout     : ${snap.totalAnswerDropout}
Total percakapan        : ${snap.totalConversations}
Distribusi grade        : A:${snap.countGradeA} B:${snap.countGradeB} C:${snap.countGradeC} D:${snap.countGradeD} E:${snap.countGradeE}

Skor per agent:
NAMA | GRADE | TOTAL | KEC_BALAS | KUALITAS | KETEPATAN | KOMPLAIN | MISSED
${agentLines}`;
  return { label: snap.periodLabel, block };
}

export async function generateMomReport(
  ownerUserId: number,
  currentJobId: string,
  previousJobId: string,
  contextBlock = ""
): Promise<Record<string, unknown> | null> {
  const [curr, prev] = await Promise.all([
    buildMomPeriodBlock(ownerUserId, currentJobId),
    buildMomPeriodBlock(ownerUserId, previousJobId),
  ]);
  if (!curr || !prev) return null;
  const resolvedAi = await resolveAiClient(ownerUserId);
  return callAiJson(
    resolvedAi,
    ACR_SYSTEM_PROMPT_MOM,
    buildMomUserPrompt({
      prevLabel: prev.label,
      currLabel: curr.label,
      prevBlock: prev.block,
      currBlock: curr.block,
      contextBlock,
    }),
    1200,
    null
  );
}

export async function generateBenchmark(
  ownerUserId: number,
  jobId: string,
  groups: { name: string; scheduleLabel: string | null; agentUserIds: number[] }[],
  contextBlock = ""
): Promise<Record<string, unknown> | null> {
  if (groups.length < 2) return null;
  const snap = await db.query.acrKpiSnapshotsTable.findFirst({
    where: and(eq(acrKpiSnapshotsTable.jobId, jobId), eq(acrKpiSnapshotsTable.ownerUserId, ownerUserId)),
  });
  const scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, jobId));
  const byId = new Map(scores.map((s) => [s.agentUserId, s]));
  const avg = (vals: number[]): number =>
    vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;

  const teamsBlock = groups
    .map((g, idx) => {
      const members = g.agentUserIds.map((id) => byId.get(id)).filter(Boolean) as typeof scores;
      const rt = members.map((m) => (m.avgResponseTimeMinutes == null ? null : Number(m.avgResponseTimeMinutes))).filter((v): v is number => v != null);
      const grades = { A: 0, B: 0, C: 0, D: 0, E: 0 } as Record<string, number>;
      for (const m of members) grades[m.grade] = (grades[m.grade] ?? 0) + 1;
      return `=== TIM ${idx + 1}: ${g.name} ===
Agent: ${members.map((m) => m.agentName ?? `#${m.agentUserId}`).join(", ") || "-"}
Jadwal: ${g.scheduleLabel ?? "-"}
Rata-rata skor   : ${avg(members.map((m) => NSTR(m.totalScore)))}
Avg waktu balas  : ${avg(rt)} menit
Chat tidak dijawab: ${members.reduce((a, m) => a + m.totalMissedChats, 0)}
Total red flag   : ${members.reduce((a, m) => a + m.redFlagCount, 0)}
Distribusi grade : A:${grades.A} B:${grades.B} C:${grades.C} D:${grades.D} E:${grades.E}
Skor dimensi rata-rata:
Kecepatan Balas : ${avg(members.map((m) => NSTR(m.scoreResponseTime)))}
Kualitas Bahasa : ${avg(members.map((m) => NSTR(m.scoreLanguageQuality)))}
Ketepatan Jawaban: ${avg(members.map((m) => NSTR(m.scoreAnswerQuality)))}
Handling Komplain: ${avg(members.map((m) => NSTR(m.scoreComplaintHandling)))}`;
    })
    .join("\n\n");

  const resolvedAi = await resolveAiClient(ownerUserId);
  return callAiJson(
    resolvedAi,
    ACR_SYSTEM_PROMPT_BENCHMARK,
    buildBenchmarkUserPrompt({
      periodLabel: snap?.periodLabel ?? jobId,
      teamsBlock,
      contextBlock,
    }),
    800,
    null
  );
}

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
