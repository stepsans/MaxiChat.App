import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, gte, lte, ilike, or, sql, inArray } from "drizzle-orm";
import {
  db,
  aiPipelinesTable,
  aiPipelineChannelsTable,
  aiPipelineExcludeLabelsTable,
  aiPipelineAnalysesTable,
  aiPipelineEntriesTable,
  aiPipelineFollowupLogsTable,
  aiPipelineCutoffLogsTable,
  aiPipelinePromptVersionsTable,
  aiPipelineVisibilityTable,
  aiPipelineUserVisibilityTable,
  channelsTable,
  customerLabelsTable,
  usersTable,
} from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  CreateAiPipelineBody,
} from "@workspace/api-zod";
import { scheduleCutoffLogs } from "../lib/ai-pipeline-scheduler";
import { generateFollowupMessage } from "../lib/ai-pipeline-followup";
import { resolveAiClient } from "../lib/ai-provider";

const router = Router();

async function resolveOwner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getPipelineWithOwner(id: number, ownerUserId: number) {
  return db.query.aiPipelinesTable.findFirst({
    where: and(
      eq(aiPipelinesTable.id, id),
      eq(aiPipelinesTable.ownerUserId, ownerUserId)
    ),
  });
}

async function buildPipelineResponse(pipeline: typeof aiPipelinesTable.$inferSelect) {
  const [channels, excludeLabels, lastLog, todayStats] = await Promise.all([
    db
      .select({ channelId: aiPipelineChannelsTable.channelId })
      .from(aiPipelineChannelsTable)
      .where(eq(aiPipelineChannelsTable.pipelineId, pipeline.id)),
    db
      .select({ labelId: aiPipelineExcludeLabelsTable.labelId })
      .from(aiPipelineExcludeLabelsTable)
      .where(eq(aiPipelineExcludeLabelsTable.pipelineId, pipeline.id)),
    db
      .select({ completedAt: aiPipelineCutoffLogsTable.completedAt })
      .from(aiPipelineCutoffLogsTable)
      .where(
        and(
          eq(aiPipelineCutoffLogsTable.pipelineId, pipeline.id),
          eq(aiPipelineCutoffLogsTable.status, "completed")
        )
      )
      .orderBy(desc(aiPipelineCutoffLogsTable.completedAt))
      .limit(1),
    buildTodayStats(pipeline.id),
  ]);

  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    isActive: pipeline.isActive,
    scoreThreshold: pipeline.scoreThreshold,
    opportunityThreshold: pipeline.opportunityThreshold,
    autoCreateOpportunity: pipeline.autoCreateOpportunity,
    autoFollowupEnabled: pipeline.autoFollowupEnabled,
    followupIntervals: pipeline.followupIntervals,
    cutoffTimes: pipeline.cutoffTimes,
    channelIds: channels.map((c) => c.channelId),
    excludeLabelIds: excludeLabels.map((l) => l.labelId),
    staleDaysThreshold: pipeline.staleDaysThreshold,
    highValueThresholdIdr: pipeline.highValueThresholdIdr,
    customPrompt: pipeline.customPrompt ?? null,
    promptVersion: pipeline.promptVersion,
    directionFilter: pipeline.directionFilter,
    lastRunAt: lastLog[0]?.completedAt?.toISOString() ?? null,
    todayStats,
    createdAt: pipeline.createdAt.toISOString(),
    updatedAt: pipeline.updatedAt.toISOString(),
  };
}

async function buildTodayStats(pipelineId: number) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [analyzed, entered, followups] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.pipelineId, pipelineId),
          gte(aiPipelineAnalysesTable.createdAt, todayStart)
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.pipelineId, pipelineId),
          eq(aiPipelineAnalysesTable.enteredPipeline, true),
          gte(aiPipelineAnalysesTable.createdAt, todayStart)
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineFollowupLogsTable)
      .where(
        and(
          eq(aiPipelineFollowupLogsTable.pipelineId, pipelineId),
          gte(aiPipelineFollowupLogsTable.sentAt, todayStart)
        )
      ),
  ]);

  return {
    analyzed: analyzed[0]?.count ?? 0,
    enteredPipeline: entered[0]?.count ?? 0,
    followupsSent: followups[0]?.count ?? 0,
  };
}

async function upsertChannelsAndLabels(
  pipelineId: number,
  channelIds: number[],
  excludeLabelIds: number[]
) {
  // Replace channels
  await db
    .delete(aiPipelineChannelsTable)
    .where(eq(aiPipelineChannelsTable.pipelineId, pipelineId));
  if (channelIds.length > 0) {
    await db.insert(aiPipelineChannelsTable).values(
      channelIds.map((channelId) => ({ pipelineId, channelId }))
    );
  }

  // Replace exclude labels
  await db
    .delete(aiPipelineExcludeLabelsTable)
    .where(eq(aiPipelineExcludeLabelsTable.pipelineId, pipelineId));
  if (excludeLabelIds.length > 0) {
    await db.insert(aiPipelineExcludeLabelsTable).values(
      excludeLabelIds.map((labelId) => ({ pipelineId, labelId }))
    );
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const pipelines = await db
    .select()
    .from(aiPipelinesTable)
    .where(eq(aiPipelinesTable.ownerUserId, ownerUserId))
    .orderBy(asc(aiPipelinesTable.createdAt));

  const results = await Promise.all(pipelines.map(buildPipelineResponse));
  res.json(results);
});

// ─── Create ───────────────────────────────────────────────────────────────────

// ─── Test prompt (no pipeline ID — for wizard preview) ───────────────────────

router.post("/test-prompt", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const { prompt, sampleMessages } = req.body as { prompt?: string; sampleMessages?: string };
  if (!prompt || !sampleMessages) {
    res.status(400).json({ error: "prompt and sampleMessages required" });
    return;
  }
  if (prompt.length < 80 || prompt.length > 1500) {
    res.status(400).json({ error: "prompt must be 80–1500 characters" });
    return;
  }

  const resolved = await resolveAiClient(ownerUserId);

  const systemPrompt = `${prompt}\n\nAnalyze the following conversation and respond with a JSON object containing: score (0-100), status (string), recommendation (string), scoreReason (string).`;

  const completion = await resolved.client.chat.completions.create({
    model: resolved.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Conversation:\n${sampleMessages}` },
    ],
    response_format: { type: "json_object" },
    max_tokens: 500,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsedResult: Record<string, unknown> = {};
  try { parsedResult = JSON.parse(raw); } catch { /* leave empty */ }

  res.json({
    score: parsedResult.score ?? null,
    status: parsedResult.status ?? null,
    recommendation: parsedResult.recommendation ?? null,
    scoreReason: parsedResult.scoreReason ?? null,
    rawResponse: raw,
  });
});

// ─── Create ───────────────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const parsed = CreateAiPipelineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  const {
    name, description, isActive, scoreThreshold,
    opportunityThreshold, autoCreateOpportunity,
    autoFollowupEnabled, followupIntervals, cutoffTimes,
    channelIds, excludeLabelIds, staleDaysThreshold, highValueThresholdIdr,
    customPrompt, directionFilter,
  } = parsed.data;

  const [pipeline] = await db
    .insert(aiPipelinesTable)
    .values({
      ownerUserId,
      name,
      description: description ?? null,
      isActive: isActive ?? true,
      scoreThreshold: scoreThreshold ?? 70,
      opportunityThreshold: opportunityThreshold ?? 80,
      autoCreateOpportunity: autoCreateOpportunity ?? false,
      autoFollowupEnabled: autoFollowupEnabled ?? false,
      followupIntervals: followupIntervals ?? ["24h", "48h", "72h"],
      cutoffTimes: cutoffTimes ?? ["12:00", "23:59"],
      staleDaysThreshold: staleDaysThreshold ?? 14,
      highValueThresholdIdr: highValueThresholdIdr ?? 0,
      customPrompt: customPrompt ?? null,
      directionFilter: directionFilter ?? true,
    })
    .returning();

  if (customPrompt) {
    const userId = getSessionUserId(req)!;
    await db.insert(aiPipelinePromptVersionsTable).values({
      pipelineId: pipeline.id,
      ownerUserId,
      version: 1,
      promptText: customPrompt,
      changedBy: userId,
    });
  }

  await upsertChannelsAndLabels(pipeline.id, channelIds ?? [], excludeLabelIds ?? []);

  // Schedule cutoff logs for the next 7 days
  await scheduleCutoffLogs(pipeline.id, ownerUserId, pipeline.cutoffTimes as string[], pipeline.timezone);

  const result = await buildPipelineResponse(pipeline);
  res.status(201).json(result);
});

// ─── Get ──────────────────────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  res.json(await buildPipelineResponse(pipeline));
});

// ─── Update ───────────────────────────────────────────────────────────────────

router.put("/:id", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const parsed = CreateAiPipelineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  const {
    name, description, isActive, scoreThreshold,
    opportunityThreshold, autoCreateOpportunity,
    autoFollowupEnabled, followupIntervals, cutoffTimes,
    channelIds, excludeLabelIds, staleDaysThreshold, highValueThresholdIdr,
    customPrompt, directionFilter,
  } = parsed.data;

  const promptChanged = customPrompt !== undefined && customPrompt !== pipeline.customPrompt;
  const nextVersion = promptChanged ? pipeline.promptVersion + 1 : pipeline.promptVersion;

  const [updated] = await db
    .update(aiPipelinesTable)
    .set({
      name,
      description: description ?? null,
      isActive: isActive ?? pipeline.isActive,
      scoreThreshold: scoreThreshold ?? pipeline.scoreThreshold,
      opportunityThreshold: opportunityThreshold ?? pipeline.opportunityThreshold,
      autoCreateOpportunity: autoCreateOpportunity ?? pipeline.autoCreateOpportunity,
      autoFollowupEnabled: autoFollowupEnabled ?? pipeline.autoFollowupEnabled,
      followupIntervals: followupIntervals ?? pipeline.followupIntervals,
      cutoffTimes: cutoffTimes ?? pipeline.cutoffTimes,
      staleDaysThreshold: staleDaysThreshold ?? pipeline.staleDaysThreshold,
      highValueThresholdIdr: highValueThresholdIdr ?? pipeline.highValueThresholdIdr,
      customPrompt: customPrompt !== undefined ? (customPrompt ?? null) : pipeline.customPrompt,
      promptVersion: nextVersion,
      directionFilter: directionFilter ?? pipeline.directionFilter,
      updatedAt: new Date(),
    })
    .where(eq(aiPipelinesTable.id, id))
    .returning();

  if (promptChanged && customPrompt) {
    const userId = getSessionUserId(req)!;
    await db.insert(aiPipelinePromptVersionsTable).values({
      pipelineId: id,
      ownerUserId,
      version: nextVersion,
      promptText: customPrompt,
      changedBy: userId,
    });
  }

  await upsertChannelsAndLabels(id, channelIds ?? [], excludeLabelIds ?? []);

  // Re-schedule cutoff logs when times change
  const oldTimes = JSON.stringify(pipeline.cutoffTimes);
  const newTimes = JSON.stringify(updated.cutoffTimes);
  if (oldTimes !== newTimes || !pipeline.isActive && updated.isActive) {
    await db
      .delete(aiPipelineCutoffLogsTable)
      .where(
        and(
          eq(aiPipelineCutoffLogsTable.pipelineId, id),
          eq(aiPipelineCutoffLogsTable.status, "pending")
        )
      );
    if (updated.isActive) {
      await scheduleCutoffLogs(id, ownerUserId, updated.cutoffTimes as string[], updated.timezone);
    }
  }

  res.json(await buildPipelineResponse(updated));
});

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete("/:id", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  await db.delete(aiPipelinesTable).where(eq(aiPipelinesTable.id, id));
  res.status(204).end();
});

// ─── Toggle active ────────────────────────────────────────────────────────────

router.patch("/:id/toggle", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const [updated] = await db
    .update(aiPipelinesTable)
    .set({ isActive: !pipeline.isActive, updatedAt: new Date() })
    .where(eq(aiPipelinesTable.id, id))
    .returning();

  res.json(await buildPipelineResponse(updated));
});

// ─── Run now (manual trigger) ─────────────────────────────────────────────────

router.post("/:id/run-now", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  // Check if already running
  const running = await db
    .select({ id: aiPipelineCutoffLogsTable.id })
    .from(aiPipelineCutoffLogsTable)
    .where(
      and(
        eq(aiPipelineCutoffLogsTable.pipelineId, id),
        eq(aiPipelineCutoffLogsTable.status, "running")
      )
    )
    .limit(1);

  if (running.length > 0) {
    res.status(409).json({ error: "A run is already in progress for this pipeline" });
    return;
  }

  // Create an immediate cutoff log entry
  const [log] = await db
    .insert(aiPipelineCutoffLogsTable)
    .values({
      pipelineId: id,
      ownerUserId,
      scheduledTime: new Date(),
      status: "pending",
    })
    .returning();

  // Trigger analysis asynchronously (non-blocking)
  const { runCutoffAnalysis } = await import("../lib/ai-pipeline-analysis");
  runCutoffAnalysis(log.id).catch((err: unknown) => {
    console.error("[ai-pipeline] run-now error:", err);
  });

  res.json({
    id: log.id,
    pipelineId: log.pipelineId,
    scheduledTime: log.scheduledTime.toISOString(),
    status: log.status,
    contactsProcessed: log.contactsProcessed,
    contactsEnteredPipeline: log.contactsEnteredPipeline,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt.toISOString(),
  });
});

// ─── Dashboard stats ─────────────────────────────────────────────────────────

router.get("/:id/dashboard-stats", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [today, allAnalyses, recent, cutoffLogs] = await Promise.all([
    buildTodayStats(id),
    db
      .select({ score: aiPipelineAnalysesTable.score })
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.pipelineId, id),
          gte(aiPipelineAnalysesTable.createdAt, todayStart)
        )
      ),
    db
      .select()
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.pipelineId, id),
          gte(aiPipelineAnalysesTable.createdAt, todayStart)
        )
      )
      .orderBy(desc(aiPipelineAnalysesTable.createdAt))
      .limit(10),
    db
      .select()
      .from(aiPipelineCutoffLogsTable)
      .where(
        and(
          eq(aiPipelineCutoffLogsTable.pipelineId, id),
          gte(aiPipelineCutoffLogsTable.scheduledTime, todayStart),
          lte(aiPipelineCutoffLogsTable.scheduledTime, todayEnd)
        )
      )
      .orderBy(asc(aiPipelineCutoffLogsTable.scheduledTime)),
  ]);

  const scoreDistribution = [
    { range: "0-40", label: "Dingin", color: "#EF4444", min: 0, max: 40 },
    { range: "41-60", label: "Hangat", color: "#F59E0B", min: 41, max: 60 },
    { range: "61-79", label: "Potensial", color: "#3B82F6", min: 61, max: 79 },
    { range: "80-100", label: "Panas", color: "#10B981", min: 80, max: 100 },
  ].map(({ range, label, color, min, max }) => ({
    range,
    label,
    color,
    count: allAnalyses.filter((a) => a.score >= min && a.score <= max).length,
  }));

  res.json({
    today,
    scoreDistribution,
    recentAnalyses: recent.map(serializeAnalysis),
    cutoffTimeline: cutoffLogs.map((l) => ({
      id: l.id,
      scheduledTime: l.scheduledTime.toISOString(),
      status: l.status,
      completedAt: l.completedAt?.toISOString() ?? null,
    })),
  });
});

// ─── Analyses ─────────────────────────────────────────────────────────────────

function serializeAnalysis(a: typeof aiPipelineAnalysesTable.$inferSelect) {
  return {
    id: a.id,
    pipelineId: a.pipelineId,
    contactPhone: a.contactPhone,
    contactName: a.contactName,
    channelId: a.channelId,
    channelType: a.channelType,
    cutoffDatetime: a.cutoffDatetime.toISOString(),
    cutoffWindowStart: a.cutoffWindowStart.toISOString(),
    cutoffWindowEnd: a.cutoffWindowEnd.toISOString(),
    score: a.score,
    previousScore: a.previousScore,
    scoreBreakdown: a.scoreBreakdown,
    status: a.status,
    estimatedValue: a.estimatedValue,
    productInterest: a.productInterest,
    recommendation: a.recommendation,
    scoreReason: a.scoreReason,
    aiNotes: a.aiNotes,
    leadClassification: a.leadClassification,
    leadClassificationReason: a.leadClassificationReason,
    conversationRole: a.conversationRole,
    skipped: a.skipped,
    skipReason: a.skipReason,
    opportunityId: a.opportunityId,
    chatId: a.chatId,
    enteredPipeline: a.enteredPipeline,
    pipelineEntryId: a.pipelineEntryId,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/:id/analyses", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const page = parseInt(String(req.query.page ?? "1"), 10) || 1;
  const pageSize = Math.min(parseInt(String(req.query.pageSize ?? "50"), 10) || 50, 200);
  const offset = (page - 1) * pageSize;

  const conditions = [eq(aiPipelineAnalysesTable.pipelineId, id)];

  if (req.query.dateFrom) {
    conditions.push(gte(aiPipelineAnalysesTable.cutoffDatetime, new Date(String(req.query.dateFrom))));
  }
  if (req.query.dateTo) {
    const dateTo = new Date(String(req.query.dateTo));
    dateTo.setHours(23, 59, 59, 999);
    conditions.push(lte(aiPipelineAnalysesTable.cutoffDatetime, dateTo));
  }
  if (req.query.channelId) {
    conditions.push(eq(aiPipelineAnalysesTable.channelId, parseInt(String(req.query.channelId), 10)));
  }
  if (req.query.enteredPipeline !== undefined) {
    conditions.push(eq(aiPipelineAnalysesTable.enteredPipeline, req.query.enteredPipeline === "true"));
  }
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    conditions.push(
      or(
        ilike(aiPipelineAnalysesTable.contactName, term),
        ilike(aiPipelineAnalysesTable.contactPhone, term)
      )!
    );
  }
  if (req.query.scoreRange) {
    const ranges: Record<string, [number, number]> = {
      cold: [0, 40], warm: [41, 60], potential: [61, 79], hot: [80, 100],
    };
    const r = ranges[String(req.query.scoreRange)];
    if (r) {
      conditions.push(
        and(
          gte(aiPipelineAnalysesTable.score, r[0]),
          lte(aiPipelineAnalysesTable.score, r[1])
        )!
      );
    }
  }

  const where = and(...conditions);
  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(aiPipelineAnalysesTable)
      .where(where)
      .orderBy(desc(aiPipelineAnalysesTable.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineAnalysesTable)
      .where(where),
  ]);

  res.json({
    data: rows.map(serializeAnalysis),
    total: countResult[0]?.count ?? 0,
    page,
    pageSize,
  });
});

router.get("/:id/analyses/:aid", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const aid = parseInt(String(req.params.aid), 10);
  if (isNaN(id) || isNaN(aid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const analysis = await db.query.aiPipelineAnalysesTable.findFirst({
    where: and(
      eq(aiPipelineAnalysesTable.id, aid),
      eq(aiPipelineAnalysesTable.pipelineId, id)
    ),
  });
  if (!analysis) { res.status(404).json({ error: "Not found" }); return; }

  res.json(serializeAnalysis(analysis));
});

// ─── Entries ──────────────────────────────────────────────────────────────────

async function serializeEntry(e: typeof aiPipelineEntriesTable.$inferSelect, withLogs = false) {
  const base = {
    id: e.id,
    pipelineId: e.pipelineId,
    analysisId: e.analysisId,
    contactPhone: e.contactPhone,
    contactName: e.contactName,
    channelId: e.channelId,
    channelType: e.channelType,
    currentScore: e.currentScore,
    estimatedValue: e.estimatedValue,
    productInterest: e.productInterest,
    status: e.status,
    followupCount: e.followupCount,
    lastFollowupAt: e.lastFollowupAt?.toISOString() ?? null,
    nextFollowupAt: e.nextFollowupAt?.toISOString() ?? null,
    doNotFollowup: e.doNotFollowup,
    doNotFollowupReason: e.doNotFollowupReason,
    cooled: e.cooled,
    cooledAt: e.cooledAt?.toISOString() ?? null,
    scoreHistory: e.scoreHistory,
    enteredAt: e.enteredAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    followupLogs: [] as ReturnType<typeof serializeFollowupLog>[],
  };

  if (withLogs) {
    const logs = await db
      .select()
      .from(aiPipelineFollowupLogsTable)
      .where(eq(aiPipelineFollowupLogsTable.entryId, e.id))
      .orderBy(asc(aiPipelineFollowupLogsTable.sentAt));
    base.followupLogs = logs.map(serializeFollowupLog);
  }

  return base;
}

function serializeFollowupLog(l: typeof aiPipelineFollowupLogsTable.$inferSelect) {
  return {
    id: l.id,
    entryId: l.entryId,
    followupNumber: l.followupNumber,
    messageSent: l.messageSent,
    sentAt: l.sentAt.toISOString(),
    wasReplied: l.wasReplied,
    repliedAt: l.repliedAt?.toISOString() ?? null,
    status: l.status,
  };
}

router.get("/:id/entries", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const page = parseInt(String(req.query.page ?? "1"), 10) || 1;
  const pageSize = Math.min(parseInt(String(req.query.pageSize ?? "50"), 10) || 50, 200);
  const offset = (page - 1) * pageSize;

  const conditions = [eq(aiPipelineEntriesTable.pipelineId, id)];

  if (req.query.status) {
    conditions.push(eq(aiPipelineEntriesTable.status, String(req.query.status)));
  }
  if (req.query.channelId) {
    conditions.push(eq(aiPipelineEntriesTable.channelId, parseInt(String(req.query.channelId), 10)));
  }
  if (req.query.search) {
    const term = `%${req.query.search}%`;
    conditions.push(
      or(
        ilike(aiPipelineEntriesTable.contactName, term),
        ilike(aiPipelineEntriesTable.contactPhone, term)
      )!
    );
  }
  if (req.query.dateFrom) {
    conditions.push(gte(aiPipelineEntriesTable.enteredAt, new Date(String(req.query.dateFrom))));
  }
  if (req.query.dateTo) {
    const dateTo = new Date(String(req.query.dateTo));
    dateTo.setHours(23, 59, 59, 999);
    conditions.push(lte(aiPipelineEntriesTable.enteredAt, dateTo));
  }

  const where = and(...conditions);
  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(aiPipelineEntriesTable)
      .where(where)
      .orderBy(desc(aiPipelineEntriesTable.enteredAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineEntriesTable)
      .where(where),
  ]);

  const data = await Promise.all(rows.map((r) => serializeEntry(r, false)));
  res.json({ data, total: countResult[0]?.count ?? 0, page, pageSize });
});

router.get("/:id/entries/:eid", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const eid = parseInt(String(req.params.eid), 10);
  if (isNaN(id) || isNaN(eid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const entry = await db.query.aiPipelineEntriesTable.findFirst({
    where: and(
      eq(aiPipelineEntriesTable.id, eid),
      eq(aiPipelineEntriesTable.pipelineId, id)
    ),
  });
  if (!entry) { res.status(404).json({ error: "Not found" }); return; }

  res.json(await serializeEntry(entry, true));
});

router.patch("/:id/entries/:eid", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const eid = parseInt(String(req.params.eid), 10);
  if (isNaN(id) || isNaN(eid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const entry = await db.query.aiPipelineEntriesTable.findFirst({
    where: and(eq(aiPipelineEntriesTable.id, eid), eq(aiPipelineEntriesTable.pipelineId, id))
  });
  if (!entry) { res.status(404).json({ error: "Not found" }); return; }

  const { status } = req.body as { status?: string };
  if (!status) { res.status(400).json({ error: "status required" }); return; }

  const [updated] = await db
    .update(aiPipelineEntriesTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(aiPipelineEntriesTable.id, eid))
    .returning();

  res.json(await serializeEntry(updated, true));
});

router.post("/:id/entries/:eid/do-not-followup", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const eid = parseInt(String(req.params.eid), 10);
  if (isNaN(id) || isNaN(eid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const entry = await db.query.aiPipelineEntriesTable.findFirst({
    where: and(eq(aiPipelineEntriesTable.id, eid), eq(aiPipelineEntriesTable.pipelineId, id))
  });
  if (!entry) { res.status(404).json({ error: "Not found" }); return; }

  const { reason } = req.body as { reason?: string };

  const [updated] = await db
    .update(aiPipelineEntriesTable)
    .set({
      doNotFollowup: true,
      doNotFollowupReason: reason ?? "Manual: jangan follow-up",
      doNotFollowupAt: new Date(),
      status: "do_not_followup",
      nextFollowupAt: null,
      updatedAt: new Date(),
    })
    .where(eq(aiPipelineEntriesTable.id, eid))
    .returning();

  res.json(await serializeEntry(updated, true));
});

// Generate (but do NOT send) an AI follow-up message for this entry, grounded
// in the contact's recent conversation. The UI drops the result into the
// follow-up composer for the operator to review/edit before sending.
router.post("/:id/entries/:eid/generate-followup", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const eid = parseInt(String(req.params.eid), 10);
  if (isNaN(id) || isNaN(eid)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const entry = await db.query.aiPipelineEntriesTable.findFirst({
    where: and(eq(aiPipelineEntriesTable.id, eid), eq(aiPipelineEntriesTable.pipelineId, id))
  });
  if (!entry) { res.status(404).json({ error: "Not found" }); return; }

  const message = await generateFollowupMessage(entry, pipeline);
  if (!message) { res.status(502).json({ error: "Gagal membuat pesan follow-up. Coba lagi." }); return; }

  res.json({ message });
});

// ─── Prompt versions ─────────────────────────────────────────────────────────

router.get("/:id/prompt-versions", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const versions = await db
    .select({
      id: aiPipelinePromptVersionsTable.id,
      version: aiPipelinePromptVersionsTable.version,
      promptText: aiPipelinePromptVersionsTable.promptText,
      changedAt: aiPipelinePromptVersionsTable.changedAt,
      changeNote: aiPipelinePromptVersionsTable.changeNote,
      changedByName: usersTable.name,
    })
    .from(aiPipelinePromptVersionsTable)
    .leftJoin(usersTable, eq(aiPipelinePromptVersionsTable.changedBy, usersTable.id))
    .where(eq(aiPipelinePromptVersionsTable.pipelineId, id))
    .orderBy(desc(aiPipelinePromptVersionsTable.version));

  res.json(versions.map((v) => ({
    ...v,
    changedAt: v.changedAt.toISOString(),
  })));
});

// ─── Visibility ───────────────────────────────────────────────────────────────

router.get("/:id/visibility/role-defaults", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const rows = await db
    .select()
    .from(aiPipelineVisibilityTable)
    .where(
      and(
        eq(aiPipelineVisibilityTable.pipelineId, id),
        eq(aiPipelineVisibilityTable.ownerUserId, ownerUserId)
      )
    );

  const defaults: Record<string, { canView: boolean; canEdit: boolean }> = {
    supervisor: { canView: true, canEdit: false },
    agent: { canView: false, canEdit: false },
  };
  for (const row of rows) {
    defaults[row.role] = { canView: row.canView, canEdit: row.canEdit };
  }

  res.json(defaults);
});

router.put("/:id/visibility/role-defaults", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const body = req.body as Record<string, { canView?: boolean; canEdit?: boolean }>;
  const allowedRoles = ["supervisor", "agent"];

  for (const role of Object.keys(body)) {
    if (!allowedRoles.includes(role)) continue;
    const { canView = false, canEdit = false } = body[role] ?? {};
    await db
      .insert(aiPipelineVisibilityTable)
      .values({ ownerUserId, pipelineId: id, role, canView, canEdit, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [
          aiPipelineVisibilityTable.ownerUserId,
          aiPipelineVisibilityTable.pipelineId,
          aiPipelineVisibilityTable.role,
        ],
        set: { canView, canEdit, updatedAt: new Date() },
      });
  }

  res.status(204).end();
});

router.get("/:id/visibility/user/:userId", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const targetUserId = parseInt(String(req.params.userId), 10);
  if (isNaN(id) || isNaN(targetUserId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const override = await db.query.aiPipelineUserVisibilityTable.findFirst({
    where: and(
      eq(aiPipelineUserVisibilityTable.pipelineId, id),
      eq(aiPipelineUserVisibilityTable.userId, targetUserId)
    ),
  });

  res.json(override
    ? { canView: override.canView, canEdit: override.canEdit, hasOverride: true }
    : { canView: null, canEdit: null, hasOverride: false }
  );
});

router.put("/:id/visibility/user/:userId", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  const targetUserId = parseInt(String(req.params.userId), 10);
  if (isNaN(id) || isNaN(targetUserId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const { canView, canEdit, remove } = req.body as { canView?: boolean; canEdit?: boolean; remove?: boolean };

  if (remove) {
    await db
      .delete(aiPipelineUserVisibilityTable)
      .where(
        and(
          eq(aiPipelineUserVisibilityTable.pipelineId, id),
          eq(aiPipelineUserVisibilityTable.userId, targetUserId)
        )
      );
    res.status(204).end();
    return;
  }

  await db
    .insert(aiPipelineUserVisibilityTable)
    .values({ userId: targetUserId, pipelineId: id, canView: canView ?? false, canEdit: canEdit ?? false, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [aiPipelineUserVisibilityTable.userId, aiPipelineUserVisibilityTable.pipelineId],
      set: { canView: canView ?? false, canEdit: canEdit ?? false, updatedAt: new Date() },
    });

  res.status(204).end();
});

// ─── Test prompt ──────────────────────────────────────────────────────────────

router.post("/:id/test-prompt", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const { prompt, sampleMessages } = req.body as { prompt?: string; sampleMessages?: string };
  if (!prompt || !sampleMessages) {
    res.status(400).json({ error: "prompt and sampleMessages required" });
    return;
  }
  if (prompt.length < 80 || prompt.length > 1500) {
    res.status(400).json({ error: "prompt must be 80–1500 characters" });
    return;
  }

  const resolved = await resolveAiClient(ownerUserId);

  const systemPrompt = `${prompt}\n\nAnalyze the following conversation and respond with a JSON object containing: score (0-100), status (string), recommendation (string), scoreReason (string).`;

  const completion = await resolved.client.chat.completions.create({
    model: resolved.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Conversation:\n${sampleMessages}` },
    ],
    response_format: { type: "json_object" },
    max_tokens: 500,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsedResult: Record<string, unknown> = {};
  try { parsedResult = JSON.parse(raw); } catch { /* leave empty */ }

  res.json({
    score: parsedResult.score ?? null,
    status: parsedResult.status ?? null,
    recommendation: parsedResult.recommendation ?? null,
    scoreReason: parsedResult.scoreReason ?? null,
    rawResponse: raw,
  });
});

// ─── Cutoff logs ──────────────────────────────────────────────────────────────

router.get("/:id/cutoff-logs", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);

  const logs = await db
    .select()
    .from(aiPipelineCutoffLogsTable)
    .where(eq(aiPipelineCutoffLogsTable.pipelineId, id))
    .orderBy(desc(aiPipelineCutoffLogsTable.scheduledTime))
    .limit(limit);

  res.json(
    logs.map((l) => ({
      id: l.id,
      pipelineId: l.pipelineId,
      scheduledTime: l.scheduledTime.toISOString(),
      startedAt: l.startedAt?.toISOString() ?? null,
      completedAt: l.completedAt?.toISOString() ?? null,
      status: l.status,
      contactsProcessed: l.contactsProcessed,
      contactsEnteredPipeline: l.contactsEnteredPipeline,
      errorMessage: l.errorMessage,
      createdAt: l.createdAt.toISOString(),
    }))
  );
});

// ─── Info stats (for the ⓘ modal on the pipeline list page) ──────────────────

router.get("/:id/info-stats", async (req: Request, res: Response) => {
  const ownerUserId = await resolveOwner(req, res);
  if (!ownerUserId) return;

  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const pipeline = await getPipelineWithOwner(id, ownerUserId);
  if (!pipeline) { res.status(404).json({ error: "Not found" }); return; }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    channelRows,
    labelRows,
    activeContactsResult,
    lateFollowupsResult,
    totalValueResult,
    analyzedTodayResult,
    lastPromptVersion,
  ] = await Promise.all([
    db
      .select({ id: channelsTable.id, label: channelsTable.label, kind: channelsTable.kind })
      .from(aiPipelineChannelsTable)
      .innerJoin(channelsTable, eq(aiPipelineChannelsTable.channelId, channelsTable.id))
      .where(eq(aiPipelineChannelsTable.pipelineId, id)),
    db
      .select({ id: customerLabelsTable.id, name: customerLabelsTable.name })
      .from(aiPipelineExcludeLabelsTable)
      .innerJoin(customerLabelsTable, eq(aiPipelineExcludeLabelsTable.labelId, customerLabelsTable.id))
      .where(eq(aiPipelineExcludeLabelsTable.pipelineId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineEntriesTable)
      .where(
        and(
          eq(aiPipelineEntriesTable.pipelineId, id),
          sql`${aiPipelineEntriesTable.status} NOT IN ('closed_won','closed_lost','do_not_followup')`
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineEntriesTable)
      .where(
        and(
          eq(aiPipelineEntriesTable.pipelineId, id),
          sql`${aiPipelineEntriesTable.nextFollowupAt} < NOW()`,
          sql`${aiPipelineEntriesTable.status} NOT IN ('closed_won','closed_lost','do_not_followup','replied')`
        )
      ),
    db
      .select({ total: sql<number>`COALESCE(SUM(${aiPipelineEntriesTable.estimatedValue}),0)::bigint` })
      .from(aiPipelineEntriesTable)
      .where(
        and(
          eq(aiPipelineEntriesTable.pipelineId, id),
          sql`${aiPipelineEntriesTable.status} NOT IN ('closed_won','closed_lost','do_not_followup')`
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.pipelineId, id),
          gte(aiPipelineAnalysesTable.createdAt, todayStart)
        )
      ),
    db
      .select({
        changedAt: aiPipelinePromptVersionsTable.changedAt,
        changedByName: usersTable.name,
      })
      .from(aiPipelinePromptVersionsTable)
      .leftJoin(usersTable, eq(aiPipelinePromptVersionsTable.changedBy, usersTable.id))
      .where(eq(aiPipelinePromptVersionsTable.pipelineId, id))
      .orderBy(desc(aiPipelinePromptVersionsTable.version))
      .limit(1),
  ]);

  const threshold = pipeline.scoreThreshold;
  let thresholdCategory: string;
  let thresholdColor: string;
  if (threshold <= 40) { thresholdCategory = "Dingin"; thresholdColor = "#EF4444"; }
  else if (threshold <= 60) { thresholdCategory = "Hangat"; thresholdColor = "#F59E0B"; }
  else if (threshold <= 79) { thresholdCategory = "Potensial"; thresholdColor = "#3B82F6"; }
  else { thresholdCategory = "Panas"; thresholdColor = "#10B981"; }

  res.json({
    pipeline: {
      id: pipeline.id,
      name: pipeline.name,
      scoreThreshold: pipeline.scoreThreshold,
      autoFollowupEnabled: pipeline.autoFollowupEnabled,
      followupIntervals: pipeline.followupIntervals,
      cutoffTimes: pipeline.cutoffTimes,
      directionFilter: pipeline.directionFilter,
      channels: channelRows.map((c) => ({ id: c.id, name: c.label, type: c.kind })),
      excludeLabels: labelRows.map((l) => ({ id: l.id, name: l.name })),
      customPrompt: pipeline.customPrompt ?? null,
      promptLastUpdatedAt: lastPromptVersion[0]?.changedAt?.toISOString() ?? null,
      promptLastUpdatedBy: lastPromptVersion[0]?.changedByName ?? null,
    },
    stats: {
      activeContacts: activeContactsResult[0]?.count ?? 0,
      lateFollowups: lateFollowupsResult[0]?.count ?? 0,
      totalEstimatedValue: Number(totalValueResult[0]?.total ?? 0),
      analyzedToday: analyzedTodayResult[0]?.count ?? 0,
    },
    scoreBreakdownExplanation: {
      threshold,
      thresholdCategory,
      thresholdColor,
    },
  });
});

export default router;
