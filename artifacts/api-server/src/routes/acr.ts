// AI Chat Report (ACR) routes — Section 3 of the ACR spec.
//
// Role scoping (Section 14):
//   super_admin → every agent / channel in the tenant
//   supervisor  → only agents with conversations on channels the supervisor
//                 can access (user_channel_access via getAllowedChannelIds)
//   agent       → only their own rows
// Every route additionally chains requirePermission("acr", action).

import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  acrConfigsTable,
  acrJobsTable,
  acrAgentScoresTable,
  acrConversationScoresTable,
  acrRedFlagsTable,
  acrNotificationsTable,
  acrSchedulesTable,
  acrKpiSnapshotsTable,
  acrAgentTargetsTable,
  acrAchievementsTable,
  acrTeamGroupsTable,
  acrPerformanceAlertsTable,
  usersTable,
  channelsTable,
  customerLabelsTable,
  type AcrAgentScoreRow,
  type AcrConfigRow,
  type AcrJobRow,
  type AcrRedFlagRow,
  type AcrScheduleRow,
  type AcrKpiSnapshotRow,
  type AcrAgentTargetRow,
  type AcrAchievementRow,
  type AcrTeamGroupRow,
  type AcrPerformanceAlertRow,
} from "@workspace/db";
import {
  UpdateAcrConfigBody,
  CreateAcrJobBody,
  CreateAcrScheduleBody,
  UpdateAcrScheduleBody,
  SetAcrScheduleActiveBody,
} from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { getCurrentTeamRole, type TeamRole } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import { getAllowedChannelIds } from "../lib/user-channel-access";
import {
  validateConfigInput,
  computeNextRunAt,
  todayWib,
  computeScheduleNextRun,
  schedulePeriod,
  type ScheduleFrequency,
} from "../lib/acr-build";
import {
  runAcrJob,
  generateAndStoreJobPdf,
  generateMomReport,
  generateBenchmark,
} from "../lib/acr-engine";
import { snapshotFromConfig } from "../lib/acr-scheduler";
import { buildAcrCsv, buildAcrPdf } from "../lib/acr-pdf";
import { logger } from "../lib/logger";

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

interface Caller {
  userId: number;
  ownerUserId: number;
  role: TeamRole;
}

async function resolveCaller(req: Request, res: Response): Promise<Caller | null> {
  const userId = getSessionUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  const [ownerUserId, role] = await Promise.all([
    resolveOwnerUserId(userId),
    getCurrentTeamRole(userId),
  ]);
  return { userId, ownerUserId, role };
}

async function getOrCreateConfig(ownerUserId: number): Promise<AcrConfigRow> {
  const existing = await db.query.acrConfigsTable.findFirst({
    where: eq(acrConfigsTable.ownerUserId, ownerUserId),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(acrConfigsTable)
    .values({ ownerUserId })
    .onConflictDoNothing({ target: acrConfigsTable.ownerUserId })
    .returning();
  if (created) return created;
  // Lost a concurrent-create race — the row exists now.
  const row = await db.query.acrConfigsTable.findFirst({
    where: eq(acrConfigsTable.ownerUserId, ownerUserId),
  });
  return row!;
}

function serializeConfig(c: AcrConfigRow) {
  return {
    id: c.id,
    weightResponseTime: c.weightResponseTime,
    weightLanguageQuality: c.weightLanguageQuality,
    weightAnswerQuality: c.weightAnswerQuality,
    weightComplaintHandling: c.weightComplaintHandling,
    weightMissedChat: c.weightMissedChat,
    slaExcellentMinutes: c.slaExcellentMinutes,
    slaGoodMinutes: c.slaGoodMinutes,
    slaAcceptableMinutes: c.slaAcceptableMinutes,
    slaPoorMinutes: c.slaPoorMinutes,
    slaCriticalMinutes: c.slaCriticalMinutes,
    gradeAThreshold: c.gradeAThreshold,
    gradeBThreshold: c.gradeBThreshold,
    gradeCThreshold: c.gradeCThreshold,
    gradeDThreshold: c.gradeDThreshold,
    allowanceGradeA: c.allowanceGradeA,
    allowanceGradeB: c.allowanceGradeB,
    allowanceGradeC: c.allowanceGradeC,
    allowanceGradeD: c.allowanceGradeD,
    allowanceGradeE: c.allowanceGradeE,
    complaintHandlingEnabled: c.complaintHandlingEnabled,
    includeOwnerInEvaluation: c.includeOwnerInEvaluation,
    autoScheduleEnabled: c.autoScheduleEnabled,
    autoScheduleFrequency: c.autoScheduleFrequency,
    autoScheduleDayOfMonth: c.autoScheduleDayOfMonth,
    autoScheduleDayOfWeek: c.autoScheduleDayOfWeek,
    autoScheduleEveryDays: c.autoScheduleEveryDays,
    autoScheduleNotifyUserIds: c.autoScheduleNotifyUserIds,
    autoScheduleNextRunAt: c.autoScheduleNextRunAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function serializeJob(
  j: AcrJobRow,
  extras?: { requestedByName?: string | null; isLatestForPeriod?: boolean }
) {
  return {
    id: j.id,
    periodStart: j.periodStart,
    periodEnd: j.periodEnd,
    requestedByUserId: j.requestedByUserId,
    requestedByName: extras?.requestedByName ?? null,
    isAutoScheduled: j.isAutoScheduled,
    status: j.status,
    progressTotal: j.progressTotal,
    progressCompleted: j.progressCompleted,
    totalAgentsEvaluated: j.totalAgentsEvaluated,
    totalConversationsAnalyzed: j.totalConversationsAnalyzed,
    totalMessagesAnalyzed: j.totalMessagesAnalyzed,
    errorMessage: j.errorMessage,
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
    createdAt: j.createdAt.toISOString(),
    archivedAt: j.archivedAt?.toISOString() ?? null,
    isLatestForPeriod: extras?.isLatestForPeriod ?? true,
    jobType: j.jobType,
    pdfPath: j.pdfPath,
    pdfGeneratedAt: j.pdfGeneratedAt?.toISOString() ?? null,
  };
}

const num = (v: string | null): number => (v == null ? 0 : Number(v));
const numOrNull = (v: string | null): number | null => (v == null ? null : Number(v));

function serializeAgentScore(s: AcrAgentScoreRow) {
  return {
    id: s.id,
    jobId: s.jobId,
    agentUserId: s.agentUserId,
    agentName: s.agentName,
    agentEmail: s.agentEmail,
    agentRole: s.agentRole,
    totalScore: num(s.totalScore),
    scoreResponseTime: num(s.scoreResponseTime),
    scoreLanguageQuality: num(s.scoreLanguageQuality),
    scoreAnswerQuality: num(s.scoreAnswerQuality),
    scoreComplaintHandling: num(s.scoreComplaintHandling),
    scoreMissedChat: num(s.scoreMissedChat),
    avgResponseTimeMinutes: numOrNull(s.avgResponseTimeMinutes),
    totalConversations: s.totalConversations,
    totalMessagesSent: s.totalMessagesSent,
    totalMissedChats: s.totalMissedChats,
    totalComplaints: s.totalComplaints,
    complaintsResolved: s.complaintsResolved,
    insufficientData: s.insufficientData,
    grade: s.grade,
    allowanceAmount: s.allowanceAmount,
    aiSummary: s.aiSummary,
    aiStrengths: s.aiStrengths,
    aiImprovements: s.aiImprovements,
    redFlagCount: s.redFlagCount,
    hasCriticalViolation: s.hasCriticalViolation,
  };
}

function serializeRedFlag(f: AcrRedFlagRow) {
  return {
    id: f.id,
    jobId: f.jobId,
    agentScoreId: f.agentScoreId,
    agentUserId: f.agentUserId,
    agentName: f.agentName,
    chatId: f.chatId,
    contactName: f.contactName,
    channelId: f.channelId,
    channelType: f.channelType,
    conversationExcerpt: f.conversationExcerpt,
    violationType: f.violationType,
    violationSeverity: f.violationSeverity,
    aiExplanation: f.aiExplanation,
    aiRecommendation: f.aiRecommendation,
    scoreImpactDimension: f.scoreImpactDimension,
    scoreImpactPoints: numOrNull(f.scoreImpactPoints),
    occurredAt: f.occurredAt?.toISOString() ?? null,
    messageTimestamp: f.messageTimestamp?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
  };
}

function serializeConversation(c: typeof acrConversationScoresTable.$inferSelect) {
  return {
    id: c.id,
    jobId: c.jobId,
    agentScoreId: c.agentScoreId,
    agentUserId: c.agentUserId,
    chatId: c.chatId,
    contactName: c.contactName,
    channelId: c.channelId,
    channelType: c.channelType,
    firstMessageAt: c.firstMessageAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    totalMessages: c.totalMessages,
    agentMessages: c.agentMessages,
    customerMessages: c.customerMessages,
    avgResponseTimeMinutes: numOrNull(c.avgResponseTimeMinutes),
    firstResponseTimeMinutes: numOrNull(c.firstResponseTimeMinutes),
    maxResponseTimeMinutes: numOrNull(c.maxResponseTimeMinutes),
    hasMissedMessage: c.hasMissedMessage,
    hasComplaint: c.hasComplaint,
    complaintResolved: c.complaintResolved,
    convScoreResponseTime: numOrNull(c.convScoreResponseTime),
    convScoreLanguageQuality: numOrNull(c.convScoreLanguageQuality),
    convScoreAnswerQuality: numOrNull(c.convScoreAnswerQuality),
    convScoreComplaintHandling: numOrNull(c.convScoreComplaintHandling),
    convScoreMissedChat: numOrNull(c.convScoreMissedChat),
    convTotalScore: numOrNull(c.convTotalScore),
    hasRedFlag: c.hasRedFlag,
    redFlagTypes: c.redFlagTypes,
    aiNotes: c.aiNotes,
    answerCausedCustomerSilent: c.answerCausedCustomerSilent,
  };
}

function serializeKpiSnapshot(s: AcrKpiSnapshotRow) {
  return {
    id: s.id,
    jobId: s.jobId,
    scheduleId: s.scheduleId,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    periodLabel: s.periodLabel,
    jobType: s.jobType,
    frequency: s.frequency,
    teamAvgScore: numOrNull(s.teamAvgScore),
    teamAvgResponseTime: numOrNull(s.teamAvgResponseTime),
    teamAvgLanguage: numOrNull(s.teamAvgLanguage),
    teamAvgAnswer: numOrNull(s.teamAvgAnswer),
    teamAvgComplaint: numOrNull(s.teamAvgComplaint),
    teamAvgMissed: numOrNull(s.teamAvgMissed),
    countGradeA: s.countGradeA,
    countGradeB: s.countGradeB,
    countGradeC: s.countGradeC,
    countGradeD: s.countGradeD,
    countGradeE: s.countGradeE,
    totalAgents: s.totalAgents,
    totalRedFlags: s.totalRedFlags,
    totalCustomerAngry: s.totalCustomerAngry,
    totalRudeLanguage: s.totalRudeLanguage,
    totalNoReplyCritical: s.totalNoReplyCritical,
    totalCustomerIgnored: s.totalCustomerIgnored,
    totalAnswerDropout: s.totalAnswerDropout,
    totalConversations: s.totalConversations,
    totalMessages: s.totalMessages,
    totalMissedChats: s.totalMissedChats,
    totalComplaints: s.totalComplaints,
    complaintsResolved: s.complaintsResolved,
    topPerformerName: s.topPerformerName,
    topPerformerScore: numOrNull(s.topPerformerScore),
    topPerformerGrade: s.topPerformerGrade,
    botPerformerName: s.botPerformerName,
    botPerformerScore: numOrNull(s.botPerformerScore),
    botPerformerGrade: s.botPerformerGrade,
    totalAllowanceAmount: s.totalAllowanceAmount,
    createdAt: s.createdAt.toISOString(),
  };
}

async function loadJobScoped(
  jobId: string,
  ownerUserId: number
): Promise<AcrJobRow | null> {
  const job = await db.query.acrJobsTable.findFirst({
    where: and(eq(acrJobsTable.id, jobId), eq(acrJobsTable.ownerUserId, ownerUserId)),
  });
  return job ?? null;
}

// The set of agent ids a caller may see inside one job. null = unrestricted.
async function visibleAgentIds(
  caller: Caller,
  jobId: string
): Promise<Set<number> | null> {
  if (caller.role === "super_admin") return null;
  if (caller.role === "agent") return new Set([caller.userId]);
  // Supervisor: agents that have at least one analyzed conversation on a
  // channel the supervisor can access — plus themselves.
  const allowed = await getAllowedChannelIds(caller.userId);
  const rows = await db
    .selectDistinct({ agentUserId: acrConversationScoresTable.agentUserId })
    .from(acrConversationScoresTable)
    .where(
      and(
        eq(acrConversationScoresTable.jobId, jobId),
        allowed.size > 0
          ? inArray(acrConversationScoresTable.channelId, [...allowed])
          : sql`false`
      )
    );
  const ids = new Set(rows.map((r) => r.agentUserId));
  ids.add(caller.userId);
  return ids;
}

// Previous comparable job: latest period_start strictly before this job's,
// same tenant, completed, not archived (Section 9).
async function findPreviousJob(job: AcrJobRow): Promise<AcrJobRow | null> {
  const prev = await db.query.acrJobsTable.findFirst({
    where: and(
      eq(acrJobsTable.ownerUserId, job.ownerUserId),
      eq(acrJobsTable.status, "completed"),
      isNull(acrJobsTable.archivedAt),
      sql`${acrJobsTable.periodStart} < ${job.periodStart}`
    ),
    orderBy: [desc(acrJobsTable.periodStart), desc(acrJobsTable.createdAt)],
  });
  return prev ?? null;
}

const intQ = (v: unknown, dflt: number, max = 100): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return dflt;
  return Math.min(n, max);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Config (Section 3.1) ───────────────────────────────────────────────────

router.get(
  "/config",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const cfg = await getOrCreateConfig(caller.ownerUserId);
    res.json(serializeConfig(cfg));
  }
);

router.put(
  "/config",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat mengubah konfigurasi." });
      return;
    }
    const parsed = UpdateAcrConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Payload tidak valid", details: parsed.error.issues });
      return;
    }
    const b = parsed.data;
    const validationError = validateConfigInput({
      weightResponseTime: b.weightResponseTime,
      weightLanguageQuality: b.weightLanguageQuality,
      weightAnswerQuality: b.weightAnswerQuality,
      weightComplaintHandling: b.weightComplaintHandling,
      weightMissedChat: b.weightMissedChat,
      slaExcellentMinutes: b.slaExcellentMinutes,
      slaGoodMinutes: b.slaGoodMinutes,
      slaAcceptableMinutes: b.slaAcceptableMinutes,
      slaPoorMinutes: b.slaPoorMinutes,
      slaCriticalMinutes: b.slaCriticalMinutes,
      gradeAThreshold: b.gradeAThreshold,
      gradeBThreshold: b.gradeBThreshold,
      gradeCThreshold: b.gradeCThreshold,
      gradeDThreshold: b.gradeDThreshold,
      allowanceGradeA: b.allowanceGradeA,
      allowanceGradeB: b.allowanceGradeB,
      allowanceGradeC: b.allowanceGradeC,
      allowanceGradeD: b.allowanceGradeD,
      allowanceGradeE: b.allowanceGradeE,
      complaintHandlingEnabled: b.complaintHandlingEnabled,
    });
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const frequency =
      b.autoScheduleFrequency === "weekly" || b.autoScheduleFrequency === "custom"
        ? b.autoScheduleFrequency
        : "monthly";
    // Notify list must stay inside the tenant.
    let notifyIds: number[] = [];
    if (Array.isArray(b.autoScheduleNotifyUserIds) && b.autoScheduleNotifyUserIds.length) {
      const candidates = b.autoScheduleNotifyUserIds.filter((n) => Number.isInteger(n));
      if (candidates.length > 0) {
        const valid = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              inArray(usersTable.id, candidates),
              or(
                eq(usersTable.id, caller.ownerUserId),
                eq(usersTable.parentUserId, caller.ownerUserId)
              )
            )
          );
        notifyIds = valid.map((v) => v.id);
      }
    }
    const nextRunAt = b.autoScheduleEnabled
      ? computeNextRunAt(
          {
            frequency,
            dayOfMonth: b.autoScheduleDayOfMonth ?? 1,
            dayOfWeek: b.autoScheduleDayOfWeek ?? 1,
            everyDays: b.autoScheduleEveryDays ?? 30,
          },
          new Date()
        )
      : null;

    await getOrCreateConfig(caller.ownerUserId);
    const [updated] = await db
      .update(acrConfigsTable)
      .set({
        weightResponseTime: b.weightResponseTime,
        weightLanguageQuality: b.weightLanguageQuality,
        weightAnswerQuality: b.weightAnswerQuality,
        weightComplaintHandling: b.weightComplaintHandling,
        weightMissedChat: b.weightMissedChat,
        slaExcellentMinutes: b.slaExcellentMinutes,
        slaGoodMinutes: b.slaGoodMinutes,
        slaAcceptableMinutes: b.slaAcceptableMinutes,
        slaPoorMinutes: b.slaPoorMinutes,
        slaCriticalMinutes: b.slaCriticalMinutes,
        gradeAThreshold: b.gradeAThreshold,
        gradeBThreshold: b.gradeBThreshold,
        gradeCThreshold: b.gradeCThreshold,
        gradeDThreshold: b.gradeDThreshold,
        allowanceGradeA: b.allowanceGradeA,
        allowanceGradeB: b.allowanceGradeB,
        allowanceGradeC: b.allowanceGradeC,
        allowanceGradeD: b.allowanceGradeD,
        allowanceGradeE: b.allowanceGradeE,
        complaintHandlingEnabled: b.complaintHandlingEnabled,
        includeOwnerInEvaluation: b.includeOwnerInEvaluation === true,
        autoScheduleEnabled: b.autoScheduleEnabled,
        autoScheduleFrequency: frequency,
        autoScheduleDayOfMonth: b.autoScheduleDayOfMonth ?? 1,
        autoScheduleDayOfWeek: b.autoScheduleDayOfWeek ?? 1,
        autoScheduleEveryDays: b.autoScheduleEveryDays ?? 30,
        autoScheduleNotifyUserIds: notifyIds,
        autoScheduleNextRunAt: nextRunAt,
      })
      .where(eq(acrConfigsTable.ownerUserId, caller.ownerUserId))
      .returning();
    res.json(serializeConfig(updated!));
  }
);

// ─── Jobs (Section 3.2) ─────────────────────────────────────────────────────

router.post(
  "/jobs",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = CreateAcrJobBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Payload tidak valid", details: parsed.error.issues });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const periodStart = typeof body.periodStart === "string" ? body.periodStart : "";
    const periodEnd = typeof body.periodEnd === "string" ? body.periodEnd : "";
    if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
      res.status(400).json({ error: "Format tanggal harus YYYY-MM-DD." });
      return;
    }
    if (periodEnd < periodStart) {
      res.status(400).json({ error: "Tanggal selesai harus >= tanggal mulai." });
      return;
    }
    const spanDays =
      (new Date(`${periodEnd}T00:00:00Z`).getTime() -
        new Date(`${periodStart}T00:00:00Z`).getTime()) /
      86_400_000;
    if (spanDays > 90) {
      res.status(400).json({ error: "Periode maksimal 90 hari." });
      return;
    }
    if (periodEnd > todayWib()) {
      res.status(400).json({ error: "Tanggal selesai tidak boleh di masa depan." });
      return;
    }

    const cfg = await getOrCreateConfig(caller.ownerUserId);

    // Per-job override of the config's include-owner toggle. Persisted on the
    // job so re-runs stay consistent with what was requested.
    const includeOwner =
      typeof parsed.data.includeOwner === "boolean"
        ? parsed.data.includeOwner
        : cfg.includeOwnerInEvaluation;

    // agent_ids must belong to this tenant (supervisor/agent members; the
    // owner only when the effective include-owner toggle is on).
    let agentIds: number[] | null = null;
    if (Array.isArray(parsed.data.agentIds) && parsed.data.agentIds.length > 0) {
      const candidates = parsed.data.agentIds.filter((n) => Number.isInteger(n));
      const memberWhere = and(
        eq(usersTable.parentUserId, caller.ownerUserId),
        inArray(usersTable.teamRole, ["supervisor", "agent"])
      );
      const valid = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            inArray(usersTable.id, candidates.length ? candidates : [-1]),
            includeOwner
              ? or(eq(usersTable.id, caller.ownerUserId), memberWhere)
              : memberWhere
          )
        );
      agentIds = valid.map((v) => v.id);
      if (agentIds.length === 0) {
        res.status(400).json({ error: "Agent yang dipilih tidak valid." });
        return;
      }
    }

    // channel_ids must belong to this tenant. Empty/omitted = all channels.
    let channelIds: number[] | null = null;
    if (Array.isArray(parsed.data.channelIds) && parsed.data.channelIds.length > 0) {
      const candidates = parsed.data.channelIds.filter((n) => Number.isInteger(n));
      const valid = await db
        .select({ id: channelsTable.id })
        .from(channelsTable)
        .where(
          and(
            eq(channelsTable.userId, caller.ownerUserId),
            inArray(channelsTable.id, candidates.length ? candidates : [-1])
          )
        );
      channelIds = valid.map((v) => v.id);
      if (channelIds.length === 0) {
        res.status(400).json({ error: "Channel yang dipilih tidak valid." });
        return;
      }
    }

    // customer_label_ids must belong to this tenant. Empty/omitted = no filter.
    let customerLabelIds: number[] | null = null;
    if (
      Array.isArray(parsed.data.customerLabelIds) &&
      parsed.data.customerLabelIds.length > 0
    ) {
      const candidates = parsed.data.customerLabelIds.filter((n) => Number.isInteger(n));
      const valid = await db
        .select({ id: customerLabelsTable.id })
        .from(customerLabelsTable)
        .where(
          and(
            eq(customerLabelsTable.ownerUserId, caller.ownerUserId),
            inArray(customerLabelsTable.id, candidates.length ? candidates : [-1])
          )
        );
      customerLabelIds = valid.map((v) => v.id);
      if (customerLabelIds.length === 0) {
        res.status(400).json({ error: "Label customer yang dipilih tidak valid." });
        return;
      }
    }

    // chat_statuses — subset of the known handling statuses. Empty/omitted = all.
    const CHAT_STATUSES = ["ai_handled", "needs_human", "closed"] as const;
    let chatStatuses: string[] | null = null;
    if (Array.isArray(parsed.data.chatStatuses) && parsed.data.chatStatuses.length > 0) {
      chatStatuses = [
        ...new Set(parsed.data.chatStatuses.filter((s) => CHAT_STATUSES.includes(s))),
      ];
      if (chatStatuses.length === 0) {
        res.status(400).json({ error: "Status chat yang dipilih tidak valid." });
        return;
      }
    }

    // lead_statuses — subset of the known lead classifications. Empty/omitted
    // defaults to ['lead'] so a new report evaluates only lead-marked chats.
    const LEAD_STATUSES = ["lead", "not_lead", "unknown"] as const;
    let leadStatuses: string[] = ["lead"];
    if (Array.isArray(parsed.data.leadStatuses) && parsed.data.leadStatuses.length > 0) {
      const valid = [
        ...new Set(parsed.data.leadStatuses.filter((s) => LEAD_STATUSES.includes(s))),
      ];
      if (valid.length === 0) {
        res.status(400).json({ error: "Lead status yang dipilih tidak valid." });
        return;
      }
      leadStatuses = valid;
    }

    const [job] = await db
      .insert(acrJobsTable)
      .values({
        ownerUserId: caller.ownerUserId,
        periodStart,
        periodEnd,
        requestedByUserId: caller.userId,
        isAutoScheduled: false,
        agentUserIds: agentIds,
        leadStatuses,
        channelIds,
        customerLabelIds,
        chatStatuses,
        includeOwner,
        jobType: "manual",
        status: "pending",
        configSnapshot: snapshotFromConfig(cfg),
      })
      .returning();

    // Run async — never block the HTTP response (Section 15.1).
    void runAcrJob(job!.id).catch((err) =>
      logger.error({ err, jobId: job!.id }, "[acr] async job run failed")
    );

    res.status(201).json(serializeJob(job!));
  }
);

router.get(
  "/jobs",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const page = intQ(req.query.page, 1, 10_000);
    const limit = intQ(req.query.limit, 10, 100);
    const archived = req.query.archived === "true";

    const where = and(
      eq(acrJobsTable.ownerUserId, caller.ownerUserId),
      archived ? sql`${acrJobsTable.archivedAt} IS NOT NULL` : isNull(acrJobsTable.archivedAt)
    );
    const [rows, [{ count }]] = await Promise.all([
      db
        .select({
          job: acrJobsTable,
          requestedByName: usersTable.name,
        })
        .from(acrJobsTable)
        .leftJoin(usersTable, eq(acrJobsTable.requestedByUserId, usersTable.id))
        .where(where)
        .orderBy(desc(acrJobsTable.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ count: sql<number>`count(*)::int` }).from(acrJobsTable).where(where),
    ]);

    // Label the newest job per identical period as "(Terbaru)" (Section 15.9).
    const latestPerPeriod = await db
      .select({
        periodStart: acrJobsTable.periodStart,
        periodEnd: acrJobsTable.periodEnd,
        maxCreated: sql<string>`max(${acrJobsTable.createdAt})`,
      })
      .from(acrJobsTable)
      .where(eq(acrJobsTable.ownerUserId, caller.ownerUserId))
      .groupBy(acrJobsTable.periodStart, acrJobsTable.periodEnd);
    const latestKey = new Set(
      latestPerPeriod.map((r) => `${r.periodStart}|${r.periodEnd}|${new Date(r.maxCreated).getTime()}`)
    );

    res.json({
      jobs: rows.map((r) =>
        serializeJob(r.job, {
          requestedByName: r.requestedByName,
          isLatestForPeriod: latestKey.has(
            `${r.job.periodStart}|${r.job.periodEnd}|${r.job.createdAt.getTime()}`
          ),
        })
      ),
      total: count,
      page,
      limit,
    });
  }
);

router.get(
  "/jobs/:jobId",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    let requestedByName: string | null = null;
    if (job.requestedByUserId != null) {
      const [u] = await db
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, job.requestedByUserId))
        .limit(1);
      requestedByName = u?.name ?? null;
    }
    res.json(serializeJob(job, { requestedByName }));
  }
);

router.patch(
  "/jobs/:jobId/archive",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat mengarsipkan laporan." });
      return;
    }
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const [updated] = await db
      .update(acrJobsTable)
      .set({ archivedAt: new Date() })
      .where(eq(acrJobsTable.id, job.id))
      .returning();
    res.json(serializeJob(updated!));
  }
);

router.get(
  "/jobs/:jobId/progress",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const pct =
      job.progressTotal > 0
        ? Math.round((job.progressCompleted / job.progressTotal) * 1000) / 10
        : job.status === "completed"
          ? 100
          : 0;
    res.json({
      status: job.status,
      progressTotal: job.progressTotal,
      progressCompleted: job.progressCompleted,
      pct,
    });
  }
);

// ─── Results (Section 3.3) ──────────────────────────────────────────────────

router.get(
  "/jobs/:jobId/results",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const visible = await visibleAgentIds(caller, job.id);
    let scores = await db
      .select()
      .from(acrAgentScoresTable)
      .where(eq(acrAgentScoresTable.jobId, job.id))
      .orderBy(desc(acrAgentScoresTable.totalScore));
    if (visible) scores = scores.filter((s) => visible.has(s.agentUserId));

    const cfg = job.configSnapshot as Record<string, number>;
    const cThreshold = Number(cfg.gradeCThreshold ?? 60);
    const avgScore =
      scores.length > 0
        ? scores.reduce((a, s) => a + num(s.totalScore), 0) / scores.length
        : 0;
    const best = scores[0] ?? null;
    const avgOf = (sel: (s: AcrAgentScoreRow) => number): number =>
      scores.length > 0
        ? Math.round((scores.reduce((a, s) => a + sel(s), 0) / scores.length) * 100) / 100
        : 0;

    // Team trend: avg score per completed job, up to the 6 most recent
    // (Section 11) — only meaningful for supervisor+ viewers.
    const trendRows = await db
      .select({
        jobId: acrAgentScoresTable.jobId,
        periodStart: acrJobsTable.periodStart,
        periodEnd: acrJobsTable.periodEnd,
        avgScore: sql<string>`avg(${acrAgentScoresTable.totalScore})`,
      })
      .from(acrAgentScoresTable)
      .innerJoin(acrJobsTable, eq(acrAgentScoresTable.jobId, acrJobsTable.id))
      .where(
        and(
          eq(acrJobsTable.ownerUserId, caller.ownerUserId),
          eq(acrJobsTable.status, "completed"),
          isNull(acrJobsTable.archivedAt),
          lte(acrJobsTable.periodStart, job.periodStart)
        )
      )
      .groupBy(acrAgentScoresTable.jobId, acrJobsTable.periodStart, acrJobsTable.periodEnd)
      .orderBy(desc(acrJobsTable.periodStart))
      .limit(6);

    res.json({
      job: serializeJob(job),
      weights: {
        weightResponseTime: Number(cfg.weightResponseTime ?? 25),
        weightLanguageQuality: Number(cfg.weightLanguageQuality ?? 25),
        weightAnswerQuality: Number(cfg.weightAnswerQuality ?? 25),
        weightComplaintHandling: Number(cfg.weightComplaintHandling ?? 15),
        weightMissedChat: Number(cfg.weightMissedChat ?? 10),
      },
      agents: scores.map(serializeAgentScore),
      summary: {
        avgScore: Math.round(avgScore * 100) / 100,
        bestAgentName: best?.agentName ?? null,
        bestAgentScore: best ? num(best.totalScore) : null,
        needsAttentionCount: scores.filter((s) => num(s.totalScore) < cThreshold).length,
        totalRedFlags: scores.reduce((a, s) => a + s.redFlagCount, 0),
      },
      gradeDistribution: {
        a: scores.filter((s) => s.grade === "A").length,
        b: scores.filter((s) => s.grade === "B").length,
        c: scores.filter((s) => s.grade === "C").length,
        d: scores.filter((s) => s.grade === "D").length,
        e: scores.filter((s) => s.grade === "E").length,
      },
      dimensionAverages: {
        responseTime: avgOf((s) => num(s.scoreResponseTime)),
        languageQuality: avgOf((s) => num(s.scoreLanguageQuality)),
        answerQuality: avgOf((s) => num(s.scoreAnswerQuality)),
        complaintHandling: avgOf((s) => num(s.scoreComplaintHandling)),
        missedChat: avgOf((s) => num(s.scoreMissedChat)),
      },
      teamTrend: trendRows
        .reverse()
        .map((t) => ({
          jobId: t.jobId,
          periodStart: t.periodStart,
          periodEnd: t.periodEnd,
          avgScore: Math.round(Number(t.avgScore) * 100) / 100,
        })),
    });
  }
);

// Shared builder for agent detail + my-scores.
async function buildAgentDetail(
  job: AcrJobRow,
  score: AcrAgentScoreRow
): Promise<Record<string, unknown>> {
  const flags = await db
    .select()
    .from(acrRedFlagsTable)
    .where(eq(acrRedFlagsTable.agentScoreId, score.id))
    .orderBy(desc(acrRedFlagsTable.occurredAt));

  // Trend: this agent's scores over the last 6 jobs up to this one.
  const trend = await db
    .select({
      score: acrAgentScoresTable,
      periodStart: acrJobsTable.periodStart,
      periodEnd: acrJobsTable.periodEnd,
    })
    .from(acrAgentScoresTable)
    .innerJoin(acrJobsTable, eq(acrAgentScoresTable.jobId, acrJobsTable.id))
    .where(
      and(
        eq(acrAgentScoresTable.agentUserId, score.agentUserId),
        eq(acrJobsTable.ownerUserId, job.ownerUserId),
        eq(acrJobsTable.status, "completed"),
        isNull(acrJobsTable.archivedAt),
        lte(acrJobsTable.periodStart, job.periodStart)
      )
    )
    .orderBy(desc(acrJobsTable.periodStart), desc(acrJobsTable.createdAt))
    .limit(6);

  let deltaVsPrevious: number | null = null;
  const prevJob = await findPreviousJob(job);
  if (prevJob) {
    const prev = await db.query.acrAgentScoresTable.findFirst({
      where: and(
        eq(acrAgentScoresTable.jobId, prevJob.id),
        eq(acrAgentScoresTable.agentUserId, score.agentUserId)
      ),
    });
    if (prev) {
      deltaVsPrevious =
        Math.round((num(score.totalScore) - num(prev.totalScore)) * 100) / 100;
    }
  }

  const ci = score.coachingInsights;
  return {
    score: serializeAgentScore(score),
    coachingInsights: ci
      ? {
          topImprovements: ci.top_improvements ?? [],
          bestConversationId: ci.best_conversation_id,
          worstConversationId: ci.worst_conversation_id,
          bestConversationExcerpt: ci.best_conversation_excerpt,
          worstConversationExcerpt: ci.worst_conversation_excerpt,
          worstConversationAnnotation: ci.worst_conversation_annotation,
          teamComparison: ci.team_comparison
            ? {
                avgResponseTimeTeam: ci.team_comparison.avg_response_time_team,
                avgScoreTeam: ci.team_comparison.avg_score_team,
                agentRank: ci.team_comparison.agent_rank,
                totalAgents: ci.team_comparison.total_agents,
              }
            : null,
        }
      : null,
    redFlags: flags.map(serializeRedFlag),
    trend: trend
      .reverse()
      .map((t) => ({
        jobId: t.score.jobId,
        periodStart: t.periodStart,
        periodEnd: t.periodEnd,
        totalScore: num(t.score.totalScore),
        scoreResponseTime: num(t.score.scoreResponseTime),
        scoreLanguageQuality: num(t.score.scoreLanguageQuality),
        scoreAnswerQuality: num(t.score.scoreAnswerQuality),
        scoreComplaintHandling: num(t.score.scoreComplaintHandling),
        scoreMissedChat: num(t.score.scoreMissedChat),
      })),
    deltaVsPrevious,
  };
}

router.get(
  "/jobs/:jobId/agents/:agentId",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const agentId = Number(String(req.params.agentId));
    const visible = await visibleAgentIds(caller, job.id);
    if (visible && !visible.has(agentId)) {
      res.status(403).json({ error: "Anda tidak punya akses ke data agent ini." });
      return;
    }
    const score = await db.query.acrAgentScoresTable.findFirst({
      where: and(
        eq(acrAgentScoresTable.jobId, job.id),
        eq(acrAgentScoresTable.agentUserId, agentId)
      ),
    });
    if (!score) {
      res.status(404).json({ error: "Skor agent tidak ditemukan." });
      return;
    }
    res.json(await buildAgentDetail(job, score));
  }
);

router.get(
  "/jobs/:jobId/red-flags",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const page = intQ(req.query.page, 1, 10_000);
    const limit = intQ(req.query.limit, 20, 100);

    const visible = await visibleAgentIds(caller, job.id);
    const conds = [eq(acrRedFlagsTable.jobId, job.id)];
    if (visible) {
      conds.push(
        visible.size > 0 ? inArray(acrRedFlagsTable.agentUserId, [...visible]) : sql`false`
      );
    }
    const agentIdQ = Number(req.query.agentId);
    if (Number.isInteger(agentIdQ) && agentIdQ > 0) {
      conds.push(eq(acrRedFlagsTable.agentUserId, agentIdQ));
    }
    if (typeof req.query.violationType === "string" && req.query.violationType) {
      conds.push(eq(acrRedFlagsTable.violationType, req.query.violationType));
    }
    if (typeof req.query.severity === "string" && req.query.severity) {
      conds.push(eq(acrRedFlagsTable.violationSeverity, req.query.severity));
    }
    const where = and(...conds);
    // Order: 'severity' (critical→high→medium, then newest), 'agent' (by name,
    // then newest), default 'latest' (newest first).
    const sort = typeof req.query.sort === "string" ? req.query.sort : "latest";
    const orderClause =
      sort === "severity"
        ? [
            sql`case ${acrRedFlagsTable.violationSeverity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
            desc(acrRedFlagsTable.occurredAt),
          ]
        : sort === "agent"
          ? [asc(acrRedFlagsTable.agentName), desc(acrRedFlagsTable.occurredAt)]
          : [desc(acrRedFlagsTable.occurredAt)];
    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(acrRedFlagsTable)
        .where(where)
        .orderBy(...orderClause)
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ count: sql<number>`count(*)::int` }).from(acrRedFlagsTable).where(where),
    ]);
    res.json({ redFlags: rows.map(serializeRedFlag), total: count, page, limit });
  }
);

router.get(
  "/jobs/:jobId/conversations/:agentId",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    const agentId = Number(String(req.params.agentId));
    const visible = await visibleAgentIds(caller, job.id);
    if (visible && !visible.has(agentId)) {
      res.status(403).json({ error: "Anda tidak punya akses ke data agent ini." });
      return;
    }
    const page = intQ(req.query.page, 1, 10_000);
    const limit = intQ(req.query.limit, 20, 100);

    const conds = [
      eq(acrConversationScoresTable.jobId, job.id),
      eq(acrConversationScoresTable.agentUserId, agentId),
    ];
    if (req.query.hasRedFlag === "true") {
      conds.push(eq(acrConversationScoresTable.hasRedFlag, true));
    }
    if (req.query.hasComplaint === "true") {
      conds.push(eq(acrConversationScoresTable.hasComplaint, true));
    }
    const where = and(...conds);
    const sort = req.query.sort;
    const orderBy =
      sort === "score_asc"
        ? sql`${acrConversationScoresTable.convTotalScore} ASC NULLS LAST`
        : sort === "response_desc"
          ? sql`${acrConversationScoresTable.avgResponseTimeMinutes} DESC NULLS LAST`
          : desc(acrConversationScoresTable.lastMessageAt);

    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(acrConversationScoresTable)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(acrConversationScoresTable)
        .where(where),
    ]);
    res.json({ conversations: rows.map(serializeConversation), total: count, page, limit });
  }
);

router.get(
  "/jobs/:jobId/leaderboard",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
    if (!job) {
      res.status(404).json({ error: "Laporan tidak ditemukan." });
      return;
    }
    // The full ranking is computed over EVERY evaluated agent so rank numbers
    // are true; an agent caller just sees other names masked (Section 6.6).
    const scores = await db
      .select()
      .from(acrAgentScoresTable)
      .where(eq(acrAgentScoresTable.jobId, job.id))
      .orderBy(desc(acrAgentScoresTable.totalScore));

    const prevJob = await findPreviousJob(job);
    const prevByAgent = new Map<number, number>();
    if (prevJob) {
      const prevScores = await db
        .select({
          agentUserId: acrAgentScoresTable.agentUserId,
          totalScore: acrAgentScoresTable.totalScore,
        })
        .from(acrAgentScoresTable)
        .where(eq(acrAgentScoresTable.jobId, prevJob.id));
      for (const p of prevScores) prevByAgent.set(p.agentUserId, num(p.totalScore));
    }

    const supervisorVisible =
      caller.role === "supervisor" ? await visibleAgentIds(caller, job.id) : null;

    const entries = scores.map((s, i) => {
      const prev = prevByAgent.get(s.agentUserId);
      const isSelf = s.agentUserId === caller.userId;
      const maskForAgent = caller.role === "agent" && !isSelf;
      const maskForSupervisor =
        supervisorVisible != null && !supervisorVisible.has(s.agentUserId) && !isSelf;
      const masked = maskForAgent || maskForSupervisor;
      return {
        rank: i + 1,
        delta: prev != null ? Math.round((num(s.totalScore) - prev) * 100) / 100 : null,
        agentUserId: masked ? 0 : s.agentUserId,
        agentName: masked ? null : s.agentName,
        agentRole: s.agentRole,
        totalScore: num(s.totalScore),
        grade: s.grade,
        allowanceAmount: masked ? 0 : s.allowanceAmount,
        isSelf,
      };
    });

    res.json({ entries, periodStart: job.periodStart, periodEnd: job.periodEnd });
  }
);

// ─── My scores (Section 3.5) ────────────────────────────────────────────────

router.get(
  "/my-scores",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const jobIdQ = typeof req.query.jobId === "string" ? req.query.jobId : null;

    let score: AcrAgentScoreRow | undefined;
    let job: AcrJobRow | null = null;
    if (jobIdQ) {
      job = await loadJobScoped(jobIdQ, caller.ownerUserId);
      if (!job) {
        res.status(404).json({ error: "Laporan tidak ditemukan." });
        return;
      }
      score = await db.query.acrAgentScoresTable.findFirst({
        where: and(
          eq(acrAgentScoresTable.jobId, job.id),
          eq(acrAgentScoresTable.agentUserId, caller.userId)
        ),
      });
    } else {
      // Latest completed job in which this user was scored.
      const [latest] = await db
        .select({ score: acrAgentScoresTable, job: acrJobsTable })
        .from(acrAgentScoresTable)
        .innerJoin(acrJobsTable, eq(acrAgentScoresTable.jobId, acrJobsTable.id))
        .where(
          and(
            eq(acrAgentScoresTable.agentUserId, caller.userId),
            eq(acrJobsTable.ownerUserId, caller.ownerUserId),
            eq(acrJobsTable.status, "completed"),
            isNull(acrJobsTable.archivedAt)
          )
        )
        .orderBy(desc(acrJobsTable.createdAt))
        .limit(1);
      score = latest?.score;
      job = latest?.job ?? null;
    }
    if (!score || !job) {
      res.status(404).json({ error: "Belum ada penilaian untuk Anda." });
      return;
    }
    res.json(await buildAgentDetail(job, score));
  }
);

// ─── Team members (agent picker for the create-report modal) ────────────────

router.get(
  "/team-members",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role === "agent") {
      res.status(403).json({ error: "Tidak diizinkan." });
      return;
    }
    // The owner appears in the picker only when the include-owner toggle is
    // on (solo-CS tenants / testing).
    const cfg = await getOrCreateConfig(caller.ownerUserId);
    const memberWhere = and(
      eq(usersTable.parentUserId, caller.ownerUserId),
      inArray(usersTable.teamRole, ["supervisor", "agent"])
    );
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        teamRole: usersTable.teamRole,
      })
      .from(usersTable)
      .where(
        cfg.includeOwnerInEvaluation
          ? or(eq(usersTable.id, caller.ownerUserId), memberWhere)
          : memberWhere
      );
    res.json(rows.map((r) => ({ ...r, teamRole: r.teamRole ?? "super_admin" })));
  }
);

// ─── Notifications (Section 3.6 / 12) ───────────────────────────────────────

router.get(
  "/notifications",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const conds = [eq(acrNotificationsTable.recipientUserId, caller.userId)];
    if (req.query.unreadOnly === "true") {
      conds.push(eq(acrNotificationsTable.isRead, false));
    }
    const rows = await db
      .select({
        notif: acrNotificationsTable,
        agentName: acrRedFlagsTable.agentName,
        violationType: acrRedFlagsTable.violationType,
        contactName: acrRedFlagsTable.contactName,
      })
      .from(acrNotificationsTable)
      .leftJoin(acrRedFlagsTable, eq(acrNotificationsTable.redFlagId, acrRedFlagsTable.id))
      .where(and(...conds))
      .orderBy(desc(acrNotificationsTable.createdAt))
      .limit(100);
    res.json(
      rows.map((r) => ({
        id: r.notif.id,
        redFlagId: r.notif.redFlagId,
        jobId: r.notif.jobId,
        isRead: r.notif.isRead,
        readAt: r.notif.readAt?.toISOString() ?? null,
        createdAt: r.notif.createdAt.toISOString(),
        agentName: r.agentName,
        violationType: r.violationType,
        contactName: r.contactName,
      }))
    );
  }
);

router.patch(
  "/notifications/read-all",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    await db
      .update(acrNotificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(acrNotificationsTable.recipientUserId, caller.userId),
          eq(acrNotificationsTable.isRead, false)
        )
      );
    res.json({ ok: true });
  }
);

router.patch(
  "/notifications/:notifId/read",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const [updated] = await db
      .update(acrNotificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(acrNotificationsTable.id, String(req.params.notifId)),
          eq(acrNotificationsTable.recipientUserId, caller.userId)
        )
      )
      .returning({ id: acrNotificationsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Notifikasi tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  }
);

// ─── Exports (Section 3.4 / 8) — binary, deliberately not in OpenAPI ────────

// Team-wide exports leak other agents' scores, so agents may not export.
async function resolveExportContext(
  req: Request,
  res: Response
): Promise<{ caller: Caller; job: AcrJobRow; scores: AcrAgentScoreRow[] } | null> {
  const caller = await resolveCaller(req, res);
  if (!caller) return null;
  if (caller.role === "agent") {
    res.status(403).json({ error: "Agent tidak dapat mengunduh laporan tim." });
    return null;
  }
  const job = await loadJobScoped(String(req.params.jobId), caller.ownerUserId);
  if (!job) {
    res.status(404).json({ error: "Laporan tidak ditemukan." });
    return null;
  }
  if (job.status !== "completed") {
    res.status(400).json({ error: "Laporan belum selesai diproses." });
    return null;
  }
  const visible = await visibleAgentIds(caller, job.id);
  let scores = await db
    .select()
    .from(acrAgentScoresTable)
    .where(eq(acrAgentScoresTable.jobId, job.id))
    .orderBy(desc(acrAgentScoresTable.totalScore));
  if (visible) scores = scores.filter((s) => visible.has(s.agentUserId));

  // Optional ?agentIds=1,2,3 narrowing (Section 8.3).
  if (typeof req.query.agentIds === "string" && req.query.agentIds.trim()) {
    const wanted = new Set(
      req.query.agentIds
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n))
    );
    if (wanted.size > 0) scores = scores.filter((s) => wanted.has(s.agentUserId));
  }
  return { caller, job, scores };
}

router.get(
  "/jobs/:jobId/export/csv",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = await resolveExportContext(req, res);
    if (!ctx) return;
    const csv = buildAcrCsv(ctx.job, ctx.scores);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="acr-${ctx.job.periodStart}_${ctx.job.periodEnd}.csv"`
    );
    // BOM so Excel opens the UTF-8 file correctly.
    res.send(`﻿${csv}`);
  }
);

router.get(
  "/jobs/:jobId/export/pdf",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = await resolveExportContext(req, res);
    if (!ctx) return;
    const includeRedFlags = req.query.includeRedFlags !== "false";
    const includeCoaching = req.query.includeCoaching === "true";

    const flagConds = [eq(acrRedFlagsTable.jobId, ctx.job.id)];
    const scoredAgentIds = ctx.scores.map((s) => s.agentUserId);
    flagConds.push(
      scoredAgentIds.length > 0
        ? inArray(acrRedFlagsTable.agentUserId, scoredAgentIds)
        : sql`false`
    );
    const redFlags = includeRedFlags
      ? await db
          .select()
          .from(acrRedFlagsTable)
          .where(and(...flagConds))
          .orderBy(desc(acrRedFlagsTable.occurredAt))
      : [];

    const [owner] = await db
      .select({ name: usersTable.name, companyName: usersTable.companyName })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.caller.ownerUserId))
      .limit(1);
    const [me] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.caller.userId))
      .limit(1);

    const pdf = await buildAcrPdf({
      job: ctx.job,
      agents: ctx.scores,
      redFlags,
      businessName: owner?.companyName || owner?.name || "MaxiChat",
      generatedByName: me?.name || me?.email || "-",
      includeRedFlags,
      includeCoaching,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="acr-${ctx.job.periodStart}_${ctx.job.periodEnd}.pdf"`
    );
    res.send(Buffer.from(pdf));
  }
);

// ─── Schedules (Bagian II) ────────────────────────────────────────────────────

function serializeSchedule(s: AcrScheduleRow) {
  return {
    id: s.id,
    name: s.name,
    isActive: s.isActive,
    frequency: s.frequency,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    cutoffHour: s.cutoffHour,
    cutoffMinute: s.cutoffMinute,
    timezone: s.timezone,
    agentIds: s.agentUserIds,
    notifyUserIds: s.notifyUserIds,
    generatePdf: s.generatePdf,
    sendWhatsappPdf: s.sendWhatsappPdf,
    nextRunAt: s.nextRunAt.toISOString(),
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastRunJobId: s.lastRunJobId,
    totalRuns: s.totalRuns,
    createdAt: s.createdAt.toISOString(),
  };
}

// Evaluable member ids for a tenant: supervisors + agents under the owner,
// plus the owner. Used to validate agentIds / notifyUserIds.
async function tenantMemberIds(ownerUserId: number): Promise<Set<number>> {
  const rows = await db
    .select({ id: usersTable.id })
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
  return new Set(rows.map((r) => r.id));
}

interface ScheduleValues {
  name: string;
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  cutoffHour: number;
  cutoffMinute: number;
  agentUserIds: number[] | null;
  notifyUserIds: number[];
  generatePdf: boolean;
  sendWhatsappPdf: boolean;
  isActive: boolean;
  nextRunAt: Date;
}

// Validate + normalize a schedule body; agentIds/notifyUserIds are filtered to
// the tenant's members. Returns values or a user-facing error string.
async function buildScheduleValues(
  body: Record<string, unknown>,
  ownerUserId: number
): Promise<{ values: ScheduleValues } | { error: string }> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nama jadwal wajib diisi." };

  const frequency = body.frequency;
  if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") {
    return { error: "Frekuensi tidak valid." };
  }
  const cutoffHour = Number(body.cutoffHour);
  const cutoffMinute = Number(body.cutoffMinute);
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 23) {
    return { error: "Jam eksekusi harus 0–23." };
  }
  if (!Number.isInteger(cutoffMinute) || cutoffMinute < 0 || cutoffMinute > 59) {
    return { error: "Menit eksekusi harus 0–59." };
  }

  let dayOfWeek: number | null = null;
  let dayOfMonth: number | null = null;
  if (frequency === "weekly") {
    const d = Number(body.dayOfWeek);
    if (!Number.isInteger(d) || d < 0 || d > 6) return { error: "Hari mingguan harus 0–6." };
    dayOfWeek = d;
  } else if (frequency === "monthly") {
    const d = Number(body.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 28) return { error: "Tanggal bulanan harus 1–28." };
    dayOfMonth = d;
  }

  const members = await tenantMemberIds(ownerUserId);

  let agentUserIds: number[] | null = null;
  if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
    const valid = [...new Set(body.agentIds.map(Number))].filter(
      (n) => Number.isInteger(n) && members.has(n)
    );
    if (valid.length === 0) return { error: "Agent yang dipilih tidak valid." };
    agentUserIds = valid;
  }

  let notifyUserIds: number[] = [];
  if (Array.isArray(body.notifyUserIds)) {
    notifyUserIds = [...new Set(body.notifyUserIds.map(Number))].filter(
      (n) => Number.isInteger(n) && members.has(n)
    );
  }

  const nextRunAt = computeScheduleNextRun(
    { frequency, dayOfWeek, dayOfMonth, cutoffHour, cutoffMinute },
    new Date()
  );

  return {
    values: {
      name,
      frequency,
      dayOfWeek,
      dayOfMonth,
      cutoffHour,
      cutoffMinute,
      agentUserIds,
      notifyUserIds,
      generatePdf: body.generatePdf !== false,
      sendWhatsappPdf: body.sendWhatsappPdf === true,
      isActive: body.isActive !== false,
      nextRunAt,
    },
  };
}

async function loadScheduleScoped(
  id: string,
  ownerUserId: number
): Promise<AcrScheduleRow | null> {
  const row = await db.query.acrSchedulesTable.findFirst({
    where: and(eq(acrSchedulesTable.id, id), eq(acrSchedulesTable.ownerUserId, ownerUserId)),
  });
  return row ?? null;
}

router.get(
  "/schedules",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const rows = await db
      .select()
      .from(acrSchedulesTable)
      .where(eq(acrSchedulesTable.ownerUserId, caller.ownerUserId))
      .orderBy(desc(acrSchedulesTable.createdAt));
    res.json(rows.map(serializeSchedule));
  }
);

router.post(
  "/schedules",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = CreateAcrScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Payload tidak valid", details: parsed.error.issues });
      return;
    }
    const built = await buildScheduleValues(req.body as Record<string, unknown>, caller.ownerUserId);
    if ("error" in built) {
      res.status(400).json({ error: built.error });
      return;
    }
    const [row] = await db
      .insert(acrSchedulesTable)
      .values({ ownerUserId: caller.ownerUserId, createdByUserId: caller.userId, ...built.values })
      .returning();
    res.status(201).json(serializeSchedule(row!));
  }
);

router.put(
  "/schedules/:id",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = UpdateAcrScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Payload tidak valid", details: parsed.error.issues });
      return;
    }
    const existing = await loadScheduleScoped(String(req.params.id), caller.ownerUserId);
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan." });
      return;
    }
    const built = await buildScheduleValues(req.body as Record<string, unknown>, caller.ownerUserId);
    if ("error" in built) {
      res.status(400).json({ error: built.error });
      return;
    }
    const [row] = await db
      .update(acrSchedulesTable)
      .set(built.values)
      .where(eq(acrSchedulesTable.id, existing.id))
      .returning();
    res.json(serializeSchedule(row!));
  }
);

router.patch(
  "/schedules/:id/active",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = SetAcrScheduleActiveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Payload tidak valid", details: parsed.error.issues });
      return;
    }
    const existing = await loadScheduleScoped(String(req.params.id), caller.ownerUserId);
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan." });
      return;
    }
    const isActive = (req.body as { isActive?: unknown }).isActive === true;
    const patch: { isActive: boolean; nextRunAt?: Date } = { isActive };
    // Resuming a paused schedule: recompute next run so it doesn't fire for a
    // missed past slot immediately.
    if (isActive && !existing.isActive) {
      patch.nextRunAt = computeScheduleNextRun(
        {
          frequency: existing.frequency as ScheduleFrequency,
          dayOfWeek: existing.dayOfWeek,
          dayOfMonth: existing.dayOfMonth,
          cutoffHour: existing.cutoffHour,
          cutoffMinute: existing.cutoffMinute,
        },
        new Date()
      );
    }
    const [row] = await db
      .update(acrSchedulesTable)
      .set(patch)
      .where(eq(acrSchedulesTable.id, existing.id))
      .returning();
    res.json(serializeSchedule(row!));
  }
);

router.delete(
  "/schedules/:id",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const deleted = await db
      .delete(acrSchedulesTable)
      .where(
        and(
          eq(acrSchedulesTable.id, String(req.params.id)),
          eq(acrSchedulesTable.ownerUserId, caller.ownerUserId)
        )
      )
      .returning({ id: acrSchedulesTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Jadwal tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  }
);

router.post(
  "/schedules/:id/run",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const sched = await loadScheduleScoped(String(req.params.id), caller.ownerUserId);
    if (!sched) {
      res.status(404).json({ error: "Jadwal tidak ditemukan." });
      return;
    }
    const cfg = await getOrCreateConfig(caller.ownerUserId);
    const { periodStart, periodEnd } = schedulePeriod(
      sched.frequency as ScheduleFrequency,
      new Date()
    );
    const [job] = await db
      .insert(acrJobsTable)
      .values({
        ownerUserId: caller.ownerUserId,
        periodStart,
        periodEnd,
        requestedByUserId: caller.userId,
        isAutoScheduled: true,
        jobType: "scheduled",
        scheduleId: sched.id,
        agentUserIds: sched.agentUserIds,
        status: "pending",
        configSnapshot: snapshotFromConfig(cfg),
      })
      .returning();
    await db
      .update(acrSchedulesTable)
      .set({ lastRunAt: new Date(), lastRunJobId: job!.id, totalRuns: sched.totalRuns + 1 })
      .where(eq(acrSchedulesTable.id, sched.id));
    void runAcrJob(job!.id)
      .then(() => (sched.generatePdf ? generateAndStoreJobPdf(job!.id) : null))
      .catch((err) =>
        logger.error({ err, jobId: job!.id }, "[acr] schedule run-now failed")
      );
    res.status(201).json(serializeJob(job!));
  }
);

// ─── Dashboard KPI (Bagian III) ─────────────────────────────────────────────
// Cross-period team aggregates read from acr_kpi_snapshots. Exposes team-wide
// data including other agents' leaderboard rows, so it is super_admin only —
// supervisors/agents use the per-report detail pages (already role-scoped).
router.get(
  "/dashboard",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat melihat Dashboard KPI." });
      return;
    }

    const freq = String(req.query.frequency ?? "all");
    const limit = intQ(req.query.limit, 12, 24);

    const conds = [eq(acrKpiSnapshotsTable.ownerUserId, caller.ownerUserId)];
    if (freq === "manual") {
      conds.push(isNull(acrKpiSnapshotsTable.frequency));
    } else if (freq === "daily" || freq === "weekly" || freq === "monthly") {
      conds.push(eq(acrKpiSnapshotsTable.frequency, freq));
    } // 'all' (or anything else) → no frequency filter

    // Newest first so current/previous are rows[0]/rows[1]; reversed for charts.
    const rows = await db
      .select()
      .from(acrKpiSnapshotsTable)
      .where(and(...conds))
      .orderBy(desc(acrKpiSnapshotsTable.periodStart), desc(acrKpiSnapshotsTable.createdAt))
      .limit(limit);

    const current = rows[0] ?? null;
    const previous = rows[1] ?? null;
    const periods = [...rows].reverse(); // oldest → newest for trend charts

    let leaderboard: ReturnType<typeof serializeAgentScore>[] = [];
    let agentTrends: {
      agentUserId: number;
      agentName: string | null;
      points: { jobId: string; periodStart: string; periodLabel: string; totalScore: number; grade: string }[];
    }[] = [];

    if (current) {
      // Per-agent leaderboard for the latest period (powers per-dimension cards
      // + the full KPI table — sorting per dimension happens client-side).
      const scores = await db
        .select()
        .from(acrAgentScoresTable)
        .where(eq(acrAgentScoresTable.jobId, current.jobId))
        .orderBy(desc(acrAgentScoresTable.totalScore));
      leaderboard = scores.map(serializeAgentScore);

      // Cross-period per-agent score matrix (Section 4.6 + trend line).
      const meta = new Map(
        rows.map((r) => [r.jobId, { periodStart: r.periodStart, periodLabel: r.periodLabel }])
      );
      const trendRows = await db
        .select({
          jobId: acrAgentScoresTable.jobId,
          agentUserId: acrAgentScoresTable.agentUserId,
          agentName: acrAgentScoresTable.agentName,
          totalScore: acrAgentScoresTable.totalScore,
          grade: acrAgentScoresTable.grade,
        })
        .from(acrAgentScoresTable)
        .where(inArray(acrAgentScoresTable.jobId, rows.map((r) => r.jobId)));

      const byAgent = new Map<number, (typeof agentTrends)[number]>();
      for (const tr of trendRows) {
        const m = meta.get(tr.jobId);
        if (!m) continue;
        let entry = byAgent.get(tr.agentUserId);
        if (!entry) {
          entry = { agentUserId: tr.agentUserId, agentName: tr.agentName, points: [] };
          byAgent.set(tr.agentUserId, entry);
        }
        entry.points.push({
          jobId: tr.jobId,
          periodStart: m.periodStart,
          periodLabel: m.periodLabel,
          totalScore: num(tr.totalScore),
          grade: tr.grade,
        });
      }
      agentTrends = [...byAgent.values()].map((a) => ({
        ...a,
        points: a.points.sort((x, y) => x.periodStart.localeCompare(y.periodStart)),
      }));
    }

    res.json({
      frequency: freq,
      periods: periods.map(serializeKpiSnapshot),
      current: current ? serializeKpiSnapshot(current) : null,
      previous: previous ? serializeKpiSnapshot(previous) : null,
      leaderboard,
      agentTrends,
    });
  }
);

// ─── Bagian IV — advanced features ──────────────────────────────────────────

function serializeTarget(t: AcrAgentTargetRow) {
  return {
    id: t.id,
    agentUserId: t.agentUserId,
    targetScore: Number(t.targetScore),
    targetDeadline: t.targetDeadline,
    setByUserId: t.setByUserId,
    updatedAt: t.updatedAt.toISOString(),
  };
}

function serializeAchievement(a: AcrAchievementRow) {
  return {
    id: a.id,
    agentUserId: a.agentUserId,
    jobId: a.jobId,
    achievementId: a.achievementId,
    achievementName: a.achievementName,
    achievementIcon: a.achievementIcon,
    description: a.description,
    earnedAtPeriod: a.earnedAtPeriod,
    earnedAt: a.earnedAt.toISOString(),
  };
}

function serializeTeamGroup(g: AcrTeamGroupRow) {
  return {
    id: g.id,
    name: g.name,
    scheduleLabel: g.scheduleLabel,
    agentUserIds: g.agentUserIds,
    updatedAt: g.updatedAt.toISOString(),
  };
}

function serializeAlert(a: AcrPerformanceAlertRow) {
  return {
    id: a.id,
    agentUserId: a.agentUserId,
    jobId: a.jobId,
    alertType: a.alertType,
    severity: a.severity,
    title: a.title,
    description: a.description,
    recommendation: a.recommendation,
    affectedDimensions: a.affectedDimensions,
    isRead: a.isRead,
    isResolved: a.isResolved,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

// ── Targets (9.1) — super admin only ──
router.get(
  "/targets",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const rows = await db
      .select()
      .from(acrAgentTargetsTable)
      .where(eq(acrAgentTargetsTable.ownerUserId, caller.ownerUserId));
    res.json(rows.map(serializeTarget));
  }
);

router.put(
  "/targets/:agentId",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const agentUserId = Number(req.params.agentId);
    if (!Number.isInteger(agentUserId)) {
      res.status(400).json({ error: "agentId tidak valid." });
      return;
    }
    const body = req.body as { targetScore?: unknown; targetDeadline?: unknown };
    const targetScore = Number(body.targetScore);
    if (!Number.isFinite(targetScore) || targetScore < 0 || targetScore > 100) {
      res.status(400).json({ error: "targetScore harus 0–100." });
      return;
    }
    const deadline =
      typeof body.targetDeadline === "string" && DATE_RE.test(body.targetDeadline)
        ? body.targetDeadline
        : null;
    const values = {
      ownerUserId: caller.ownerUserId,
      agentUserId,
      targetScore: targetScore.toFixed(2),
      targetDeadline: deadline,
      setByUserId: caller.userId,
    };
    const [row] = await db
      .insert(acrAgentTargetsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [acrAgentTargetsTable.ownerUserId, acrAgentTargetsTable.agentUserId],
        set: { targetScore: values.targetScore, targetDeadline: deadline, setByUserId: caller.userId },
      })
      .returning();
    res.json(serializeTarget(row!));
  }
);

router.delete(
  "/targets/:agentId",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const agentUserId = Number(req.params.agentId);
    await db
      .delete(acrAgentTargetsTable)
      .where(
        and(
          eq(acrAgentTargetsTable.ownerUserId, caller.ownerUserId),
          eq(acrAgentTargetsTable.agentUserId, agentUserId)
        )
      );
    res.json({ ok: true });
  }
);

// ── Performance alerts (9.2) ──
router.get(
  "/alerts",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const conds = [eq(acrPerformanceAlertsTable.ownerUserId, caller.ownerUserId)];
    if (caller.role === "agent") conds.push(eq(acrPerformanceAlertsTable.agentUserId, caller.userId));
    if (req.query.unresolvedOnly === "true")
      conds.push(eq(acrPerformanceAlertsTable.isResolved, false));
    const rows = await db
      .select()
      .from(acrPerformanceAlertsTable)
      .where(and(...conds))
      .orderBy(desc(acrPerformanceAlertsTable.createdAt))
      .limit(100);
    res.json(rows.map(serializeAlert));
  }
);

router.patch(
  "/alerts/:id/resolve",
  requirePermission("acr", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const [row] = await db
      .update(acrPerformanceAlertsTable)
      .set({ isResolved: true, isRead: true, resolvedAt: new Date() })
      .where(
        and(
          eq(acrPerformanceAlertsTable.id, String(req.params.id)),
          eq(acrPerformanceAlertsTable.ownerUserId, caller.ownerUserId)
        )
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Alert tidak ditemukan." });
      return;
    }
    res.json(serializeAlert(row));
  }
);

// ── Achievements (9.6) ──
router.get(
  "/achievements",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const conds = [eq(acrAchievementsTable.ownerUserId, caller.ownerUserId)];
    if (caller.role === "agent") conds.push(eq(acrAchievementsTable.agentUserId, caller.userId));
    else if (req.query.agentId) {
      const a = Number(req.query.agentId);
      if (Number.isInteger(a)) conds.push(eq(acrAchievementsTable.agentUserId, a));
    }
    const rows = await db
      .select()
      .from(acrAchievementsTable)
      .where(and(...conds))
      .orderBy(desc(acrAchievementsTable.earnedAt))
      .limit(100);
    res.json(rows.map(serializeAchievement));
  }
);

// ── Team groups (9.3) — super admin only ──
router.get(
  "/team-groups",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const rows = await db
      .select()
      .from(acrTeamGroupsTable)
      .where(eq(acrTeamGroupsTable.ownerUserId, caller.ownerUserId))
      .orderBy(asc(acrTeamGroupsTable.name));
    res.json(rows.map(serializeTeamGroup));
  }
);

function parseTeamGroupBody(
  body: Record<string, unknown>
): { name: string; scheduleLabel: string | null; agentUserIds: number[] } | { error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nama tim wajib diisi." };
  const ids = Array.isArray(body.agentUserIds)
    ? (body.agentUserIds as unknown[]).map(Number).filter((n) => Number.isInteger(n))
    : [];
  const scheduleLabel =
    typeof body.scheduleLabel === "string" && body.scheduleLabel.trim()
      ? body.scheduleLabel.trim()
      : null;
  return { name, scheduleLabel, agentUserIds: ids };
}

router.post(
  "/team-groups",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = parseTeamGroupBody(req.body as Record<string, unknown>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const [row] = await db
      .insert(acrTeamGroupsTable)
      .values({ ownerUserId: caller.ownerUserId, ...parsed })
      .returning();
    res.status(201).json(serializeTeamGroup(row!));
  }
);

router.put(
  "/team-groups/:id",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const parsed = parseTeamGroupBody(req.body as Record<string, unknown>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const [row] = await db
      .update(acrTeamGroupsTable)
      .set(parsed)
      .where(
        and(
          eq(acrTeamGroupsTable.id, String(req.params.id)),
          eq(acrTeamGroupsTable.ownerUserId, caller.ownerUserId)
        )
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Tim tidak ditemukan." });
      return;
    }
    res.json(serializeTeamGroup(row));
  }
);

router.delete(
  "/team-groups/:id",
  requirePermission("acr", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    const deleted = await db
      .delete(acrTeamGroupsTable)
      .where(
        and(
          eq(acrTeamGroupsTable.id, String(req.params.id)),
          eq(acrTeamGroupsTable.ownerUserId, caller.ownerUserId)
        )
      )
      .returning({ id: acrTeamGroupsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Tim tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  }
);

// ── MoM report (9.5) — super admin only, on-demand AI ──
router.get(
  "/mom",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin." });
      return;
    }
    const currentJobId = String(req.query.currentJobId ?? "");
    const previousJobId = String(req.query.previousJobId ?? "");
    if (!currentJobId || !previousJobId) {
      res.status(400).json({ error: "currentJobId dan previousJobId wajib." });
      return;
    }
    const report = await generateMomReport(caller.ownerUserId, currentJobId, previousJobId);
    if (!report) {
      res.status(404).json({ error: "Data periode tidak lengkap untuk perbandingan." });
      return;
    }
    res.json(report);
  }
);

// ── Benchmark (9.3) — super admin only, on-demand AI ──
router.get(
  "/benchmark",
  requirePermission("acr", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const caller = await resolveCaller(req, res);
    if (!caller) return;
    if (caller.role !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin." });
      return;
    }
    const jobId = String(req.query.jobId ?? "");
    if (!jobId) {
      res.status(400).json({ error: "jobId wajib." });
      return;
    }
    const groups = await db
      .select()
      .from(acrTeamGroupsTable)
      .where(eq(acrTeamGroupsTable.ownerUserId, caller.ownerUserId));
    if (groups.length < 2) {
      res.status(400).json({ error: "Butuh minimal 2 tim untuk benchmark." });
      return;
    }
    const result = await generateBenchmark(
      caller.ownerUserId,
      jobId,
      groups.map((g) => ({
        name: g.name,
        scheduleLabel: g.scheduleLabel,
        agentUserIds: g.agentUserIds,
      }))
    );
    if (!result) {
      res.status(404).json({ error: "Tidak bisa membuat benchmark." });
      return;
    }
    res.json(result);
  }
);

export default router;
