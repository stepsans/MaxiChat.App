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
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  acrConfigsTable,
  acrJobsTable,
  acrAgentScoresTable,
  acrConversationScoresTable,
  acrRedFlagsTable,
  acrNotificationsTable,
  usersTable,
  type AcrAgentScoreRow,
  type AcrConfigRow,
  type AcrJobRow,
  type AcrRedFlagRow,
} from "@workspace/db";
import { UpdateAcrConfigBody, CreateAcrJobBody } from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { getCurrentTeamRole, type TeamRole } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import { getAllowedChannelIds } from "../lib/user-channel-access";
import { validateConfigInput, computeNextRunAt, todayWib } from "../lib/acr-build";
import { runAcrJob } from "../lib/acr-engine";
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

    // agent_ids must belong to this tenant (supervisor/agent members).
    let agentIds: number[] | null = null;
    if (Array.isArray(parsed.data.agentIds) && parsed.data.agentIds.length > 0) {
      const candidates = parsed.data.agentIds.filter((n) => Number.isInteger(n));
      const valid = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            inArray(usersTable.id, candidates.length ? candidates : [-1]),
            or(
              // The owner is evaluable too (self-service CS / testing).
              eq(usersTable.id, caller.ownerUserId),
              and(
                eq(usersTable.parentUserId, caller.ownerUserId),
                inArray(usersTable.teamRole, ["supervisor", "agent"])
              )
            )
          )
        );
      agentIds = valid.map((v) => v.id);
      if (agentIds.length === 0) {
        res.status(400).json({ error: "Agent yang dipilih tidak valid." });
        return;
      }
    }

    const cfg = await getOrCreateConfig(caller.ownerUserId);
    const [job] = await db
      .insert(acrJobsTable)
      .values({
        ownerUserId: caller.ownerUserId,
        periodStart,
        periodEnd,
        requestedByUserId: caller.userId,
        isAutoScheduled: false,
        agentUserIds: agentIds,
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
    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(acrRedFlagsTable)
        .where(where)
        .orderBy(desc(acrRedFlagsTable.occurredAt))
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
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        teamRole: usersTable.teamRole,
      })
      .from(usersTable)
      .where(
        or(
          // Owner included: small tenants do CS themselves (and it makes
          // single-account testing possible).
          eq(usersTable.id, caller.ownerUserId),
          and(
            eq(usersTable.parentUserId, caller.ownerUserId),
            inArray(usersTable.teamRole, ["supervisor", "agent"])
          )
        )
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

export default router;
