import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  pipelinesTable,
  pipelineStagesTable,
  opportunitiesTable,
  opportunityProductsTable,
  opportunityFollowUpsTable,
  salesAuditEventsTable,
  salesInsightsTable,
  salesAssistantSettingsTable,
  chatsTable,
  channelsTable,
} from "@workspace/db";
import {
  CreateSalesStageBody,
  UpdateSalesStageBody,
  CreateOpportunityBody,
  UpdateOpportunityBody,
  ListOpportunitiesQueryParams,
  UpdateSalesAssistantSettingsBody,
  ReorderSalesStagesBody,
  UpdateOpportunityFollowUpBody,
} from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requirePermission } from "../lib/role-permissions";
import {
  requireSalesAssistant,
  seedDefaultPipelines,
  seedDefaultStages,
  getDefaultPipeline,
  resolveTeamRole,
  opportunityScopeWhere,
  canAccessOpportunity,
  isValidAssignee,
} from "../lib/sales-assistant";
import { analyzeAndPersistChat } from "../lib/sales-insight";
import { applyAutoCreateForResult } from "../lib/sales-detection";
import { computePipelineHealth } from "../lib/pipeline-health-build";
import { computeSalesForecast } from "../lib/sales-forecast-build";
import {
  decideManualFollowUpSend,
  type FollowUpStatus,
} from "../lib/follow-up-manual-build";
import { generateFollowUpMessage } from "../lib/follow-up-message";
import { getOrCreateTenantSettings } from "../lib/settings-store";
import { sendFollowUpOnChannel } from "./whatsapp";

// ===========================================================================
// AI Sales Assistant routes (Enterprise-only). Mounted under /sales behind
// requireAuth + enforceSubscription (in routes/index) + requireSalesAssistant
// (here). Every handler resolves the tenant OWNER from the session (team
// members roll up) and scopes by owner; agents are further scoped to their
// own assigned opportunities via opportunityScopeWhere / canAccessOpportunity.
//
// FOUNDATION PHASE: CRUD + read surface only. No AI scoring / follow-up
// generation logic lives here yet (later tasks). Money is whole-int Rupiah —
// OpenAPI integer codegens to zod.number(), so we re-check Number.isInteger at
// the boundary for every Rupiah/score/id field.
// ===========================================================================

const router = Router();

// Enterprise entitlement gate for the whole namespace.
router.use(requireSalesAssistant);

// Resolve the caller's tenant owner id, or 401 if not signed in.
async function resolveOwner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

function serializePipeline(p: typeof pipelinesTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    pipelineType: p.pipelineType,
    color: p.color,
    isDefault: p.isDefault,
    isArchived: p.isArchived,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function serializeStage(s: typeof pipelineStagesTable.$inferSelect) {
  return {
    id: s.id,
    pipelineId: s.pipelineId,
    name: s.name,
    sortOrder: s.sortOrder,
    isWon: s.isWon,
    isLost: s.isLost,
    color: s.color,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function serializeOpportunity(
  o: typeof opportunitiesTable.$inferSelect,
  extra?: {
    profilePicUrl?: string | null;
    channelLabel?: string | null;
    channelColor?: string | null;
    stageName?: string | null;
    pipelineName?: string | null;
    products?: Array<{ productId: number | null; productName: string }>;
  }
) {
  return {
    id: o.id,
    assignedUserId: o.assignedUserId,
    chatId: o.chatId,
    channelId: o.channelId,
    pipelineId: o.pipelineId,
    contactPhone: o.contactPhone,
    contactName: o.contactName,
    stageId: o.stageId,
    intentKey: o.intentKey,
    intentType: o.intentType,
    leadScore: o.leadScore,
    intentCategory: o.intentCategory,
    estimatedValueIdr: o.estimatedValueIdr,
    status: o.status,
    waitingStatus: o.waitingStatus,
    productInterest: o.productInterest,
    scoreReason: o.scoreReason,
    aiNotes: o.aiNotes,
    recommendation: o.recommendation,
    analyzedAt: o.analyzedAt ? o.analyzedAt.toISOString() : null,
    analyzedMessageIds: o.analyzedMessageIds,
    keyQuotes: o.keyQuotes,
    lastActivityAt: o.lastActivityAt ? o.lastActivityAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    // Enriched fields from JOINs
    profilePicUrl: extra?.profilePicUrl ?? null,
    channelLabel: extra?.channelLabel ?? null,
    channelColor: extra?.channelColor ?? null,
    stageName: extra?.stageName ?? null,
    pipelineName: extra?.pipelineName ?? null,
    products: extra?.products ?? [],
  };
}

type InsightOpportunitySummary = Array<{
  id: number;
  pipelineId: number | null;
  pipelineName: string | null;
  stageId: number | null;
  stageName: string | null;
  intentKey: string | null;
  intentType: string;
  leadScore: number;
  lastActivityAt: Date | null;
}>;

function serializeInsight(
  i: typeof salesInsightsTable.$inferSelect,
  opps: InsightOpportunitySummary = []
) {
  return {
    id: i.id,
    chatId: i.chatId,
    channelId: i.channelId,
    contactPhone: i.contactPhone,
    leadScore: i.leadScore,
    intentCategory: i.intentCategory,
    estimatedValueIdr: i.estimatedValueIdr,
    productInterest: i.productInterest,
    scoreReason: i.scoreReason,
    aiNotes: i.aiNotes,
    recommendation: i.recommendation,
    waitingStatus: i.waitingStatus,
    analyzedAt: i.analyzedAt.toISOString(),
    // Backwards-compat single-opp fields (first/highest-scored opportunity).
    opportunityId: opps[0]?.id ?? null,
    stageId: opps[0]?.stageId ?? null,
    stageName: opps[0]?.stageName ?? null,
    lastActivityAt: opps[0]?.lastActivityAt
      ? opps[0].lastActivityAt.toISOString()
      : null,
    // New: all opportunities for this chat.
    opportunities: opps.map((o) => ({
      id: o.id,
      pipelineId: o.pipelineId,
      pipelineName: o.pipelineName,
      stageId: o.stageId,
      stageName: o.stageName,
      intentKey: o.intentKey,
      intentType: o.intentType,
      leadScore: o.leadScore,
      lastActivityAt: o.lastActivityAt ? o.lastActivityAt.toISOString() : null,
    })),
    // Raw AI-detected candidates from the latest analysis. Allows the sidebar
    // to show per-candidate "Buat" buttons even when auto-create is OFF. A
    // candidate whose intentKey already exists in `opportunities` above is
    // already persisted; the frontend filters those out before offering "Buat".
    detectedCandidates: (i.detectedCandidates ?? []) as Array<{
      intentKey: string;
      intentType: string;
      pipelineType: string;
      products: string[];
      intentCategory: string;
      leadScore: number;
      estimatedValueIdr: number;
      scoreReason: string | null;
      aiNotes: string | null;
      recommendation: string | null;
    }>,
  };
}

// Load all opportunities for a chat with their stage/pipeline names.
async function loadInsightOpportunities(
  chatId: number,
  ownerId: number
): Promise<InsightOpportunitySummary> {
  return db
    .select({
      id: opportunitiesTable.id,
      pipelineId: opportunitiesTable.pipelineId,
      pipelineName: pipelinesTable.name,
      stageId: opportunitiesTable.stageId,
      stageName: pipelineStagesTable.name,
      intentKey: opportunitiesTable.intentKey,
      intentType: opportunitiesTable.intentType,
      leadScore: opportunitiesTable.leadScore,
      lastActivityAt: opportunitiesTable.lastActivityAt,
    })
    .from(opportunitiesTable)
    .leftJoin(
      pipelineStagesTable,
      eq(pipelineStagesTable.id, opportunitiesTable.stageId)
    )
    .leftJoin(
      pipelinesTable,
      eq(pipelinesTable.id, opportunitiesTable.pipelineId)
    )
    .where(
      and(
        eq(opportunitiesTable.chatId, chatId),
        eq(opportunitiesTable.ownerUserId, ownerId)
      )
    )
    .orderBy(desc(opportunitiesTable.leadScore));
}

// Per-owner AI Sales Assistant config defaults. Inert by default: auto-create
// OFF (the AI only recommends) at a 70 threshold.
const DEFAULT_AUTO_CREATE_ENABLED = false;
const DEFAULT_AUTO_CREATE_THRESHOLD = 70;
// Pipeline Health defaults: a deal goes stale after 14 days idle; 0 high-value
// threshold means only staleness matters until the owner raises the bar.
const DEFAULT_STALE_DAYS_THRESHOLD = 14;
const DEFAULT_HIGH_VALUE_THRESHOLD_IDR = 0;
// Auto Follow-Up defaults: engine OFF (AI only recommends, never sends) with a
// 48h silence window before the next follow-up touch is due.
const DEFAULT_AUTO_FOLLOW_UP_ENABLED = false;
const DEFAULT_FOLLOW_UP_INTERVAL_HOURS = 48;

// Verify a chat is visible to THIS caller. Two-layer check, mirroring the chat
// endpoints: (1) the chat's channel must belong to the tenant owner, and (2) the
// channel must be in the caller's per-channel access set (super_admin sees all
// owned channels via getAllowedChannelIds). Returns false when the chat is gone,
// belongs to another tenant, or sits in a channel the caller can't see — so an
// agent can never read/refresh insights for a chat outside their channel scope.
async function chatVisibleToUser(
  chatId: number,
  ownerId: number,
  userId: number
): Promise<boolean> {
  const [row] = await db
    .select({ owner: channelsTable.userId, channelId: chatsTable.channelId })
    .from(chatsTable)
    .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
    .where(eq(chatsTable.id, chatId))
    .limit(1);
  if (!row || row.owner !== ownerId) return false;
  const { getAllowedChannelIds } = await import("../lib/user-channel-access");
  const allowed = await getAllowedChannelIds(userId);
  return allowed.has(row.channelId);
}

// ---------------------------------------------------------------------------
// Pipelines — tenant-scoped boards (Sales, Service, custom).
// ---------------------------------------------------------------------------

// GET /sales/pipelines — list all pipelines with their stages.
router.get(
  "/pipelines",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const pipelinesWithStages = await seedDefaultPipelines(ownerId);
    res.json(
      pipelinesWithStages.map(({ pipeline, stages }) => ({
        ...serializePipeline(pipeline),
        stages: stages.map(serializeStage),
      }))
    );
  }
);

// POST /sales/pipelines — create a custom pipeline.
router.post(
  "/pipelines",
  requirePermission("opportunities", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Nama pipeline harus diisi" });
      return;
    }
    if (name.length > 80) {
      res.status(400).json({ error: "Nama pipeline maksimal 80 karakter" });
      return;
    }
    const color = typeof req.body.color === "string" ? req.body.color.trim() : "#6366f1";
    const pipelineTypeRaw = typeof req.body.pipelineType === "string" ? req.body.pipelineType : "custom";
    const pipelineType = (
      ["sales", "service", "custom"].includes(pipelineTypeRaw) ? pipelineTypeRaw : "custom"
    ) as "sales" | "service" | "custom";
    try {
      const [row] = await db
        .insert(pipelinesTable)
        .values({
          ownerUserId: ownerId,
          name,
          pipelineType,
          color,
          isDefault: false,
          isArchived: false,
          sortOrder: 99,
        })
        .returning();
      res.status(201).json({ ...serializePipeline(row), stages: [] });
    } catch (err) {
      req.log.error({ err }, "create pipeline failed");
      res.status(409).json({ error: "Nama pipeline sudah dipakai" });
    }
  }
);

// PATCH /sales/pipelines/:id — update name/color/isArchived.
router.patch(
  "/pipelines/:id",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [existing] = await db
      .select()
      .from(pipelinesTable)
      .where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.ownerUserId, ownerId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Pipeline tidak ditemukan" });
      return;
    }
    const patch: Partial<typeof pipelinesTable.$inferInsert> = {};
    if (typeof req.body.name === "string") {
      const name = req.body.name.trim();
      if (!name || name.length > 80) {
        res.status(400).json({ error: "Nama pipeline tidak valid (1–80 karakter)" });
        return;
      }
      patch.name = name;
    }
    if (typeof req.body.color === "string") patch.color = req.body.color.trim();
    if (typeof req.body.isArchived === "boolean") patch.isArchived = req.body.isArchived;
    if (typeof req.body.isDefault === "boolean" && req.body.isDefault === true) {
      // Promote this pipeline to default; demote the current default.
      patch.isDefault = true;
      await db
        .update(pipelinesTable)
        .set({ isDefault: false })
        .where(and(eq(pipelinesTable.ownerUserId, ownerId), eq(pipelinesTable.isDefault, true)));
    }
    if (typeof req.body.sortOrder === "number" && Number.isInteger(req.body.sortOrder)) {
      patch.sortOrder = req.body.sortOrder;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }
    try {
      const [row] = await db
        .update(pipelinesTable)
        .set(patch)
        .where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.ownerUserId, ownerId)))
        .returning();
      if (!row) {
        res.status(404).json({ error: "Pipeline tidak ditemukan" });
        return;
      }
      res.json(serializePipeline(row));
    } catch (err) {
      req.log.error({ err }, "update pipeline failed");
      res.status(409).json({ error: "Nama pipeline sudah dipakai" });
    }
  }
);

// DELETE /sales/pipelines/:id — archive (soft-delete). Cannot delete the
// default pipeline or a pipeline with open opportunities.
router.delete(
  "/pipelines/:id",
  requirePermission("opportunities", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [pipeline] = await db
      .select()
      .from(pipelinesTable)
      .where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.ownerUserId, ownerId)))
      .limit(1);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline tidak ditemukan" });
      return;
    }
    if (pipeline.isDefault) {
      res.status(409).json({ error: "Pipeline default tidak dapat dihapus" });
      return;
    }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.ownerUserId, ownerId),
          eq(opportunitiesTable.pipelineId, id),
          eq(opportunitiesTable.status, "open")
        )
      );
    if (count > 0) {
      res.status(409).json({
        error: `Pipeline masih memiliki ${count} opportunity aktif. Pindahkan atau tutup dulu sebelum menghapus.`,
      });
      return;
    }
    // Soft-delete: archive the pipeline (preserves history for closed deals).
    const [row] = await db
      .update(pipelinesTable)
      .set({ isArchived: true })
      .where(and(eq(pipelinesTable.id, id), eq(pipelinesTable.ownerUserId, ownerId)))
      .returning();
    res.json({ success: true, archived: true, id: row?.id });
  }
);

// ---------------------------------------------------------------------------
// Pipeline stages (board columns). Stages are tenant CONFIGURATION; create/
// edit/delete need the "edit"/"delete" opportunity perm.
// ---------------------------------------------------------------------------

// GET /sales/stages — list stages. Optional ?pipelineId= to filter by pipeline.
// Without the filter returns all stages across all pipelines (backwards compat).
router.get(
  "/stages",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    // Seed pipelines+stages if this is a first access.
    await seedDefaultPipelines(ownerId);
    const pipelineIdFilter = req.query.pipelineId != null
      ? Number(req.query.pipelineId)
      : null;
    if (pipelineIdFilter != null && !Number.isInteger(pipelineIdFilter)) {
      res.status(400).json({ error: "pipelineId tidak valid" });
      return;
    }
    const conds = [eq(pipelineStagesTable.ownerUserId, ownerId)];
    if (pipelineIdFilter != null) {
      // Verify the pipeline belongs to this owner.
      const [pl] = await db
        .select({ id: pipelinesTable.id })
        .from(pipelinesTable)
        .where(and(eq(pipelinesTable.id, pipelineIdFilter), eq(pipelinesTable.ownerUserId, ownerId)))
        .limit(1);
      if (!pl) {
        res.status(404).json({ error: "Pipeline tidak ditemukan" });
        return;
      }
      conds.push(eq(pipelineStagesTable.pipelineId, pipelineIdFilter));
    }
    const stages = await db
      .select()
      .from(pipelineStagesTable)
      .where(and(...conds))
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
    res.json(stages.map(serializeStage));
  }
);

// POST /sales/stages — create a stage. Requires pipelineId in body.
router.post(
  "/stages",
  requirePermission("opportunities", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const parsed = CreateSalesStageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data stage tidak valid" });
      return;
    }
    const body = parsed.data;
    if (body.sortOrder != null && !Number.isInteger(body.sortOrder)) {
      res.status(400).json({ error: "sortOrder harus bilangan bulat" });
      return;
    }
    // pipelineId is required for multi-pipeline (not yet in generated schema,
    // so read directly from body and validate manually).
    const pipelineId = req.body.pipelineId != null ? Number(req.body.pipelineId) : null;
    if (pipelineId == null || !Number.isInteger(pipelineId)) {
      res.status(400).json({ error: "pipelineId harus diisi" });
      return;
    }
    const [pipeline] = await db
      .select({ id: pipelinesTable.id })
      .from(pipelinesTable)
      .where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.ownerUserId, ownerId)))
      .limit(1);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline tidak ditemukan" });
      return;
    }
    try {
      const [row] = await db
        .insert(pipelineStagesTable)
        .values({
          ownerUserId: ownerId,
          pipelineId,
          name: body.name,
          sortOrder: body.sortOrder ?? 0,
          isWon: body.isWon ?? false,
          isLost: body.isLost ?? false,
          color: body.color ?? null,
        })
        .returning();
      res.status(201).json(serializeStage(row));
    } catch (err) {
      req.log.error({ err }, "create sales stage failed");
      res.status(409).json({ error: "Nama stage sudah dipakai" });
    }
  }
);

// PATCH /sales/stages/:id — update a stage.
router.patch(
  "/stages/:id",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const parsed = UpdateSalesStageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data stage tidak valid" });
      return;
    }
    const body = parsed.data;
    if (body.sortOrder != null && !Number.isInteger(body.sortOrder)) {
      res.status(400).json({ error: "sortOrder harus bilangan bulat" });
      return;
    }
    const patch: Partial<typeof pipelineStagesTable.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (body.isWon !== undefined) patch.isWon = body.isWon;
    if (body.isLost !== undefined) patch.isLost = body.isLost;
    if (body.color !== undefined) patch.color = body.color ?? null;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }
    try {
      const [row] = await db
        .update(pipelineStagesTable)
        .set(patch)
        .where(
          and(
            eq(pipelineStagesTable.id, id),
            eq(pipelineStagesTable.ownerUserId, ownerId)
          )
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "Stage tidak ditemukan" });
        return;
      }
      res.json(serializeStage(row));
    } catch (err) {
      req.log.error({ err }, "update sales stage failed");
      res.status(409).json({ error: "Nama stage sudah dipakai" });
    }
  }
);

// POST /sales/stages/reorder — reassign sortOrder by array index. Scoped to
// a single pipeline (pipelineId required). The payload must list EXACTLY that
// pipeline's current stage ids. Applied in one transaction.
router.post(
  "/stages/reorder",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const parsed = ReorderSalesStagesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data tidak valid" });
      return;
    }
    const stageIds = parsed.data.stageIds;
    if (!stageIds.every((n: number) => Number.isInteger(n))) {
      res.status(400).json({ error: "stageIds harus bilangan bulat" });
      return;
    }
    if (new Set(stageIds).size !== stageIds.length) {
      res.status(400).json({ error: "stageIds tidak boleh duplikat" });
      return;
    }

    const pipelineId = req.body.pipelineId != null ? Number(req.body.pipelineId) : null;
    if (pipelineId == null || !Number.isInteger(pipelineId)) {
      res.status(400).json({ error: "pipelineId harus diisi" });
      return;
    }
    const [pipeline] = await db
      .select({ id: pipelinesTable.id })
      .from(pipelinesTable)
      .where(and(eq(pipelinesTable.id, pipelineId), eq(pipelinesTable.ownerUserId, ownerId)))
      .limit(1);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline tidak ditemukan" });
      return;
    }

    const owned = await db
      .select({ id: pipelineStagesTable.id })
      .from(pipelineStagesTable)
      .where(
        and(
          eq(pipelineStagesTable.ownerUserId, ownerId),
          eq(pipelineStagesTable.pipelineId, pipelineId)
        )
      );
    const ownedIds = new Set(owned.map((s) => s.id));
    if (
      stageIds.length !== ownedIds.size ||
      !stageIds.every((id: number) => ownedIds.has(id))
    ) {
      res.status(400).json({ error: "stageIds harus mencakup semua stage pipeline ini" });
      return;
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < stageIds.length; i++) {
        await tx
          .update(pipelineStagesTable)
          .set({ sortOrder: i })
          .where(
            and(
              eq(pipelineStagesTable.id, stageIds[i]!),
              eq(pipelineStagesTable.ownerUserId, ownerId)
            )
          );
      }
    });

    const rows = await db
      .select()
      .from(pipelineStagesTable)
      .where(
        and(
          eq(pipelineStagesTable.ownerUserId, ownerId),
          eq(pipelineStagesTable.pipelineId, pipelineId)
        )
      )
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
    res.json(rows.map(serializeStage));
  }
);

// DELETE /sales/stages/:id — delete a stage. Blocked with 409 (catalog-style,
// like plan delete) when any opportunity still references it; the caller must
// move those deals to another stage first. This keeps the board honest rather
// than silently unstaging deals.
router.delete(
  "/stages/:id",
  requirePermission("opportunities", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }

    const [stage] = await db
      .select({ id: pipelineStagesTable.id })
      .from(pipelineStagesTable)
      .where(
        and(
          eq(pipelineStagesTable.id, id),
          eq(pipelineStagesTable.ownerUserId, ownerId)
        )
      )
      .limit(1);
    if (!stage) {
      res.status(404).json({ error: "Stage tidak ditemukan" });
      return;
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(opportunitiesTable)
      .where(
        and(
          eq(opportunitiesTable.ownerUserId, ownerId),
          eq(opportunitiesTable.stageId, id)
        )
      );
    if (count > 0) {
      res.status(409).json({
        error: `Stage masih memiliki ${count} opportunity. Pindahkan dulu ke stage lain sebelum menghapus.`,
      });
      return;
    }

    await db
      .delete(pipelineStagesTable)
      .where(
        and(
          eq(pipelineStagesTable.id, id),
          eq(pipelineStagesTable.ownerUserId, ownerId)
        )
      );
    res.json({ success: true });
  }
);

// ---------------------------------------------------------------------------
// Opportunities (deals). Agents see only their own assigned deals.
// ---------------------------------------------------------------------------

// GET /sales/opportunities — list (scoped by role). Accepts optional filters:
// ?pipelineId=, ?stageId=, ?status=. Returns enriched data (profilePicUrl,
// channelLabel, stageName, products) via JOINs.
router.get(
  "/opportunities",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const q = ListOpportunitiesQueryParams.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Query tidak valid" });
      return;
    }
    const conds = [opportunityScopeWhere(ownerId, teamRole, uid)];
    if (q.data.stageId != null) {
      if (!Number.isInteger(q.data.stageId)) {
        res.status(400).json({ error: "stageId tidak valid" });
        return;
      }
      conds.push(eq(opportunitiesTable.stageId, q.data.stageId));
    }
    if (q.data.status) {
      conds.push(eq(opportunitiesTable.status, q.data.status));
    }
    // pipelineId filter (not yet in generated schema — read from query directly).
    const pipelineIdRaw = req.query.pipelineId != null ? Number(req.query.pipelineId) : null;
    if (pipelineIdRaw != null) {
      if (!Number.isInteger(pipelineIdRaw)) {
        res.status(400).json({ error: "pipelineId tidak valid" });
        return;
      }
      conds.push(eq(opportunitiesTable.pipelineId, pipelineIdRaw));
    }

    const rows = await db
      .select({
        opp: opportunitiesTable,
        profilePicUrl: chatsTable.profilePicUrl,
        channelLabel: channelsTable.label,
        channelColor: channelsTable.color,
        stageName: pipelineStagesTable.name,
        pipelineName: pipelinesTable.name,
      })
      .from(opportunitiesTable)
      .leftJoin(chatsTable, eq(chatsTable.id, opportunitiesTable.chatId))
      .leftJoin(channelsTable, eq(channelsTable.id, opportunitiesTable.channelId))
      .leftJoin(pipelineStagesTable, eq(pipelineStagesTable.id, opportunitiesTable.stageId))
      .leftJoin(pipelinesTable, eq(pipelinesTable.id, opportunitiesTable.pipelineId))
      .where(and(...conds))
      .orderBy(desc(opportunitiesTable.updatedAt));

    // Bulk-load products for all returned opportunities.
    const oppIds = rows.map((r) => r.opp.id);
    const allProducts = oppIds.length > 0
      ? await db
          .select()
          .from(opportunityProductsTable)
          .where(sql`${opportunityProductsTable.opportunityId} = ANY(ARRAY[${sql.join(oppIds.map((id) => sql`${id}`), sql`, `)}]::int[])`)
      : [];
    const productsByOpp = new Map<number, Array<{ productId: number | null; productName: string }>>();
    for (const p of allProducts) {
      const list = productsByOpp.get(p.opportunityId) ?? [];
      list.push({ productId: p.productId ?? null, productName: p.productName });
      productsByOpp.set(p.opportunityId, list);
    }

    res.json(
      rows.map((r) =>
        serializeOpportunity(r.opp, {
          profilePicUrl: r.profilePicUrl,
          channelLabel: r.channelLabel,
          channelColor: r.channelColor,
          stageName: r.stageName,
          pipelineName: r.pipelineName,
          products: productsByOpp.get(r.opp.id) ?? [],
        })
      )
    );
  }
);

// POST /sales/opportunities — manually create an opportunity for a chat. The
// chat must belong to the tenant; channel + contact fields are derived from it.
router.post(
  "/opportunities",
  requirePermission("opportunities", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const parsed = CreateOpportunityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data opportunity tidak valid" });
      return;
    }
    const body = parsed.data;
    if (!Number.isInteger(body.chatId)) {
      res.status(400).json({ error: "chatId tidak valid" });
      return;
    }
    if (
      body.estimatedValueIdr != null &&
      !Number.isInteger(body.estimatedValueIdr)
    ) {
      res.status(400).json({ error: "Nilai estimasi harus bilangan bulat" });
      return;
    }
    if (body.leadScore != null && !Number.isInteger(body.leadScore)) {
      res.status(400).json({ error: "Lead score harus bilangan bulat" });
      return;
    }
    if (body.stageId != null && !Number.isInteger(body.stageId)) {
      res.status(400).json({ error: "stageId tidak valid" });
      return;
    }
    if (body.assignedUserId != null && !Number.isInteger(body.assignedUserId)) {
      res.status(400).json({ error: "assignedUserId tidak valid" });
      return;
    }

    // Verify the chat belongs to this tenant (chat → channel → owner) and pull
    // the derived channel/contact fields.
    const [chat] = await db
      .select({
        id: chatsTable.id,
        channelId: chatsTable.channelId,
        phoneNumber: chatsTable.phoneNumber,
        contactName: chatsTable.contactName,
        channelOwner: channelsTable.userId,
      })
      .from(chatsTable)
      .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
      .where(eq(chatsTable.id, body.chatId))
      .limit(1);
    if (!chat || chat.channelOwner !== ownerId || chat.channelId == null) {
      res.status(404).json({ error: "Chat tidak ditemukan" });
      return;
    }

    // The assignee (if provided) must belong to this tenant — never accept a
    // cross-tenant or non-existent user id.
    if (
      body.assignedUserId != null &&
      !(await isValidAssignee(body.assignedUserId, ownerId))
    ) {
      res.status(400).json({ error: "Agen tujuan tidak valid" });
      return;
    }

    // Validate the stage belongs to the tenant (if provided).
    if (body.stageId != null) {
      const [stage] = await db
        .select({ id: pipelineStagesTable.id })
        .from(pipelineStagesTable)
        .where(
          and(
            eq(pipelineStagesTable.id, body.stageId),
            eq(pipelineStagesTable.ownerUserId, ownerId)
          )
        )
        .limit(1);
      if (!stage) {
        res.status(400).json({ error: "Stage tidak ditemukan" });
        return;
      }
    }

    // Optional intentKey — from AI candidate, used for dedup when creating from a detected candidate.
    const intentKey = typeof req.body.intentKey === "string" && req.body.intentKey.trim()
      ? req.body.intentKey.trim()
      : null;

    // Optional pipelineId — if not provided, use the owner's default pipeline.
    let pipelineId: number | null = null;
    const rawPipelineId = req.body.pipelineId != null ? Number(req.body.pipelineId) : null;
    if (rawPipelineId != null) {
      if (!Number.isInteger(rawPipelineId)) {
        res.status(400).json({ error: "pipelineId tidak valid" });
        return;
      }
      const [pl] = await db
        .select({ id: pipelinesTable.id })
        .from(pipelinesTable)
        .where(and(eq(pipelinesTable.id, rawPipelineId), eq(pipelinesTable.ownerUserId, ownerId)))
        .limit(1);
      if (!pl) {
        res.status(404).json({ error: "Pipeline tidak ditemukan" });
        return;
      }
      pipelineId = rawPipelineId;
    } else {
      const defaultPl = await getDefaultPipeline(ownerId);
      pipelineId = defaultPl?.id ?? null;
    }

    // If no stageId provided, default to first stage of the chosen pipeline.
    let resolvedStageId = body.stageId ?? null;
    if (resolvedStageId == null && pipelineId != null) {
      const [firstStage] = await db
        .select({ id: pipelineStagesTable.id })
        .from(pipelineStagesTable)
        .where(eq(pipelineStagesTable.pipelineId, pipelineId))
        .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
        .limit(1);
      resolvedStageId = firstStage?.id ?? null;
    }

    try {
      const [row] = await db
        .insert(opportunitiesTable)
        .values({
          ownerUserId: ownerId,
          assignedUserId: body.assignedUserId ?? null,
          chatId: chat.id,
          channelId: chat.channelId,
          pipelineId,
          contactPhone: chat.phoneNumber,
          contactName: body.contactName ?? chat.contactName ?? null,
          stageId: resolvedStageId,
          intentKey: intentKey ?? null,
          leadScore: body.leadScore ?? 0,
          intentCategory: body.intentCategory ?? null,
          estimatedValueIdr: body.estimatedValueIdr ?? 0,
          status: body.status ?? "open",
          waitingStatus: body.waitingStatus ?? null,
          productInterest: body.productInterest ?? [],
          aiNotes: body.aiNotes ?? null,
          lastActivityAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [opportunitiesTable.chatId, opportunitiesTable.intentKey],
          // On conflict (same chat + intentKey already exists), just return the
          // existing row so the caller gets the id without an error.
          set: { updatedAt: new Date() },
        })
        .returning();
      await db.insert(salesAuditEventsTable).values({
        ownerUserId: ownerId,
        opportunityId: row.id,
        actorUserId: getSessionUserId(req),
        eventType: "opportunity_created",
        detail: { source: "manual", pipelineId },
      });
      res.status(201).json(serializeOpportunity(row));
    } catch (err) {
      req.log.error({ err }, "create opportunity failed");
      res
        .status(409)
        .json({ error: "Opportunity untuk chat ini sudah ada" });
    }
  }
);

// GET /sales/opportunities/:id — fetch one (role-scoped) with enriched data.
router.get(
  "/opportunities/:id",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [enriched] = await db
      .select({
        opp: opportunitiesTable,
        profilePicUrl: chatsTable.profilePicUrl,
        channelLabel: channelsTable.label,
        channelColor: channelsTable.color,
        stageName: pipelineStagesTable.name,
      })
      .from(opportunitiesTable)
      .leftJoin(chatsTable, eq(chatsTable.id, opportunitiesTable.chatId))
      .leftJoin(channelsTable, eq(channelsTable.id, opportunitiesTable.channelId))
      .leftJoin(pipelineStagesTable, eq(pipelineStagesTable.id, opportunitiesTable.stageId))
      .where(eq(opportunitiesTable.id, id))
      .limit(1);
    if (!enriched || !canAccessOpportunity(enriched.opp, ownerId, teamRole, uid)) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }
    const products = await db
      .select()
      .from(opportunityProductsTable)
      .where(eq(opportunityProductsTable.opportunityId, id));
    res.json(
      serializeOpportunity(enriched.opp, {
        profilePicUrl: enriched.profilePicUrl,
        channelLabel: enriched.channelLabel,
        channelColor: enriched.channelColor,
        stageName: enriched.stageName,
        products: products.map((p) => ({ productId: p.productId ?? null, productName: p.productName })),
      })
    );
  }
);

// PATCH /sales/opportunities/:id — update (role-scoped).
router.patch(
  "/opportunities/:id",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const parsed = UpdateOpportunityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data opportunity tidak valid" });
      return;
    }
    const body = parsed.data;
    if (
      body.estimatedValueIdr != null &&
      !Number.isInteger(body.estimatedValueIdr)
    ) {
      res.status(400).json({ error: "Nilai estimasi harus bilangan bulat" });
      return;
    }
    if (body.leadScore != null && !Number.isInteger(body.leadScore)) {
      res.status(400).json({ error: "Lead score harus bilangan bulat" });
      return;
    }
    if (body.stageId != null && !Number.isInteger(body.stageId)) {
      res.status(400).json({ error: "stageId tidak valid" });
      return;
    }
    if (body.assignedUserId != null && !Number.isInteger(body.assignedUserId)) {
      res.status(400).json({ error: "assignedUserId tidak valid" });
      return;
    }

    const [existing] = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, id))
      .limit(1);
    if (!existing || !canAccessOpportunity(existing, ownerId, teamRole, uid)) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }

    // The assignee (if provided) must belong to this tenant.
    if (
      body.assignedUserId != null &&
      !(await isValidAssignee(body.assignedUserId, ownerId))
    ) {
      res.status(400).json({ error: "Agen tujuan tidak valid" });
      return;
    }

    if (body.stageId != null) {
      const [stage] = await db
        .select({ id: pipelineStagesTable.id })
        .from(pipelineStagesTable)
        .where(
          and(
            eq(pipelineStagesTable.id, body.stageId),
            eq(pipelineStagesTable.ownerUserId, ownerId)
          )
        )
        .limit(1);
      if (!stage) {
        res.status(400).json({ error: "Stage tidak ditemukan" });
        return;
      }
    }

    const patch: Partial<typeof opportunitiesTable.$inferInsert> = {};
    if (body.assignedUserId !== undefined)
      patch.assignedUserId = body.assignedUserId ?? null;
    if (body.stageId !== undefined) patch.stageId = body.stageId ?? null;
    if (body.contactName !== undefined)
      patch.contactName = body.contactName ?? null;
    if (body.leadScore !== undefined) patch.leadScore = body.leadScore;
    if (body.intentCategory !== undefined)
      patch.intentCategory = body.intentCategory ?? null;
    if (body.estimatedValueIdr !== undefined)
      patch.estimatedValueIdr = body.estimatedValueIdr;
    if (body.status !== undefined) patch.status = body.status;
    if (body.waitingStatus !== undefined)
      patch.waitingStatus = body.waitingStatus ?? null;
    if (body.productInterest !== undefined)
      patch.productInterest = body.productInterest;
    if (body.aiNotes !== undefined) patch.aiNotes = body.aiNotes ?? null;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }
    patch.lastActivityAt = new Date();

    // Re-assert authorization at the SQL level so a concurrent change between
    // the pre-read and this write can't let the caller mutate a row they no
    // longer control (TOCTOU).
    const [row] = await db
      .update(opportunitiesTable)
      .set(patch)
      .where(
        and(
          eq(opportunitiesTable.id, id),
          opportunityScopeWhere(ownerId, teamRole, uid)
        )
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }
    if (body.stageId !== undefined && body.stageId !== existing.stageId) {
      await db.insert(salesAuditEventsTable).values({
        ownerUserId: ownerId,
        opportunityId: id,
        actorUserId: uid,
        eventType: "stage_changed",
        detail: { from: existing.stageId, to: body.stageId ?? null },
      });
    }
    res.json(serializeOpportunity(row));
  }
);

// DELETE /sales/opportunities/:id — delete (role-scoped). Follow-ups and
// opportunity-anchored audit events cascade with the row; the deletion itself
// is recorded as an owner-scoped audit event (opportunityId NULL so it survives
// the cascade) with the deleted id + phone captured in detail.
router.delete(
  "/opportunities/:id",
  requirePermission("opportunities", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }

    // Delete + authorize in one statement so a concurrent change between a
    // pre-read and the write can't let the caller remove a row they no longer
    // control (TOCTOU). opportunityScopeWhere restricts agents to their own.
    // The delete and its audit row share one transaction so the deletion is
    // never recorded as having happened without the row actually going (or
    // vice-versa).
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(opportunitiesTable)
        .where(
          and(
            eq(opportunitiesTable.id, id),
            opportunityScopeWhere(ownerId, teamRole, uid)
          )
        )
        .returning();
      if (!row) return null;
      await tx.insert(salesAuditEventsTable).values({
        ownerUserId: ownerId,
        opportunityId: null,
        actorUserId: uid,
        eventType: "opportunity_deleted",
        detail: { opportunityId: id, contactPhone: row.contactPhone ?? null },
      });
      return row;
    });
    if (!deleted) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  }
);

// GET /sales/opportunities/:id/follow-ups — list follow-ups (role-scoped via
// the parent opportunity).
router.get(
  "/opportunities/:id/follow-ups",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [opp] = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, id))
      .limit(1);
    if (!opp || !canAccessOpportunity(opp, ownerId, teamRole, uid)) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }
    const rows = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.opportunityId, id))
      .orderBy(asc(opportunityFollowUpsTable.sequence));
    res.json(
      rows.map((f) => ({
        id: f.id,
        opportunityId: f.opportunityId,
        sequence: f.sequence,
        scheduledAt: f.scheduledAt.toISOString(),
        status: f.status,
        generatedMessage: f.generatedMessage,
        sentAt: f.sentAt ? f.sentAt.toISOString() : null,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      }))
    );
  }
);

// GET /sales/insights — aggregate pipeline metrics scoped to the caller.
router.get(
  "/insights",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const scope = opportunityScopeWhere(ownerId, teamRole, uid);

    const [totals] = await db
      .select({
        totalOpen: sql<number>`count(*) filter (where ${opportunitiesTable.status} = 'open')::int`,
        totalWon: sql<number>`count(*) filter (where ${opportunitiesTable.status} = 'won')::int`,
        totalLost: sql<number>`count(*) filter (where ${opportunitiesTable.status} = 'lost')::int`,
        openValueIdr: sql<number>`coalesce(sum(${opportunitiesTable.estimatedValueIdr}) filter (where ${opportunitiesTable.status} = 'open'), 0)::bigint`,
        wonValueIdr: sql<number>`coalesce(sum(${opportunitiesTable.estimatedValueIdr}) filter (where ${opportunitiesTable.status} = 'won'), 0)::bigint`,
      })
      .from(opportunitiesTable)
      .where(scope);

    const stages = await db
      .select()
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.ownerUserId, ownerId))
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));

    const perStage = await db
      .select({
        stageId: opportunitiesTable.stageId,
        count: sql<number>`count(*)::int`,
        valueIdr: sql<number>`coalesce(sum(${opportunitiesTable.estimatedValueIdr}), 0)::bigint`,
      })
      .from(opportunitiesTable)
      .where(and(scope, eq(opportunitiesTable.status, "open")))
      .groupBy(opportunitiesTable.stageId);

    const byStageMap = new Map(
      perStage.map((p) => [p.stageId ?? -1, p])
    );
    const byStage: {
      stageId: number | null;
      stageName: string;
      count: number;
      valueIdr: number;
    }[] = stages.map((s) => {
      const hit = byStageMap.get(s.id);
      return {
        stageId: s.id,
        stageName: s.name,
        count: Number(hit?.count ?? 0),
        valueIdr: Number(hit?.valueIdr ?? 0),
      };
    });
    const unstaged = byStageMap.get(-1);
    if (unstaged) {
      byStage.push({
        stageId: null,
        stageName: "Tanpa Stage",
        count: Number(unstaged.count),
        valueIdr: Number(unstaged.valueIdr),
      });
    }

    res.json({
      totalOpen: Number(totals?.totalOpen ?? 0),
      totalWon: Number(totals?.totalWon ?? 0),
      totalLost: Number(totals?.totalLost ?? 0),
      openValueIdr: Number(totals?.openValueIdr ?? 0),
      wonValueIdr: Number(totals?.wonValueIdr ?? 0),
      byStage,
    });
  }
);

// ---------------------------------------------------------------------------
// AI Sales Insight (per-chat) + AI Sales Assistant settings.
// ---------------------------------------------------------------------------

// GET /sales/insights/chat/:chatId — the latest AI Sales Insight for a chat.
router.get(
  "/insights/chat/:chatId",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const chatId = Number(req.params.chatId);
    if (!Number.isInteger(chatId)) {
      res.status(400).json({ error: "chatId tidak valid" });
      return;
    }
    if (!(await chatVisibleToUser(chatId, ownerId, uid))) {
      res.status(404).json({ error: "Chat tidak ditemukan" });
      return;
    }
    const [row] = await db
      .select()
      .from(salesInsightsTable)
      .where(
        and(
          eq(salesInsightsTable.chatId, chatId),
          eq(salesInsightsTable.ownerUserId, ownerId)
        )
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Belum ada analisa untuk chat ini" });
      return;
    }
    const opp = await loadInsightOpportunities(chatId, ownerId);
    res.json(serializeInsight(row, opp));
  }
);

// POST /sales/insights/chat/:chatId/analyze — run/refresh the analysis now.
router.post(
  "/insights/chat/:chatId/analyze",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const chatId = Number(req.params.chatId);
    if (!Number.isInteger(chatId)) {
      res.status(400).json({ error: "chatId tidak valid" });
      return;
    }
    if (!(await chatVisibleToUser(chatId, ownerId, uid))) {
      res.status(404).json({ error: "Chat tidak ditemukan" });
      return;
    }
    try {
      const result = await analyzeAndPersistChat(chatId);
      // Apply the tenant's Auto-Create toggle on the manual path too, so a manual
      // re-analysis behaves identically to background detection. Best-effort: a
      // create failure must never fail the analysis the user just requested.
      try {
        await applyAutoCreateForResult(result);
      } catch (err) {
        req.log.warn({ err, chatId }, "manual analyze auto-create failed");
      }
      const opp = await loadInsightOpportunities(chatId, ownerId);
      res.json(serializeInsight(result.insight, opp));
    } catch (err) {
      req.log.error({ err, chatId }, "manual sales insight analyze failed");
      res.status(502).json({ error: "Analisa AI gagal. Coba lagi." });
    }
  }
);

// GET /sales/settings — the tenant's AI Sales Assistant settings (defaults if
// the owner has never configured them).
router.get(
  "/settings",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const [row] = await db
      .select()
      .from(salesAssistantSettingsTable)
      .where(eq(salesAssistantSettingsTable.ownerUserId, ownerId))
      .limit(1);
    res.json({
      autoCreateEnabled: row?.autoCreateEnabled ?? DEFAULT_AUTO_CREATE_ENABLED,
      autoCreateThreshold:
        row?.autoCreateThreshold ?? DEFAULT_AUTO_CREATE_THRESHOLD,
      staleDaysThreshold:
        row?.staleDaysThreshold ?? DEFAULT_STALE_DAYS_THRESHOLD,
      highValueThresholdIdr:
        row?.highValueThresholdIdr ?? DEFAULT_HIGH_VALUE_THRESHOLD_IDR,
      autoFollowUpEnabled:
        row?.autoFollowUpEnabled ?? DEFAULT_AUTO_FOLLOW_UP_ENABLED,
      followUpIntervalHours:
        row?.followUpIntervalHours ?? DEFAULT_FOLLOW_UP_INTERVAL_HOURS,
    });
  }
);

// PATCH /sales/settings — update the tenant's AI Sales Assistant settings.
// Editing settings is a tenant-CONFIGURATION change → requires the "edit"
// opportunity permission (super_admin / supervisor with edit).
router.patch(
  "/settings",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const parsed = UpdateSalesAssistantSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data setelan tidak valid" });
      return;
    }
    const body = parsed.data;
    // Re-check integer at the boundary (OpenAPI integer codegens to a zod
    // number that accepts decimals).
    if (
      body.autoCreateThreshold != null &&
      (!Number.isInteger(body.autoCreateThreshold) ||
        body.autoCreateThreshold < 0 ||
        body.autoCreateThreshold > 100)
    ) {
      res
        .status(400)
        .json({ error: "Threshold harus bilangan bulat 0–100" });
      return;
    }
    if (
      body.staleDaysThreshold != null &&
      (!Number.isInteger(body.staleDaysThreshold) ||
        body.staleDaysThreshold < 1 ||
        body.staleDaysThreshold > 365)
    ) {
      res
        .status(400)
        .json({ error: "Hari stale harus bilangan bulat 1–365" });
      return;
    }
    if (
      body.highValueThresholdIdr != null &&
      (!Number.isInteger(body.highValueThresholdIdr) ||
        body.highValueThresholdIdr < 0)
    ) {
      res.status(400).json({
        error: "Nilai high-value harus bilangan bulat (Rupiah) >= 0",
      });
      return;
    }
    if (
      body.followUpIntervalHours != null &&
      (!Number.isInteger(body.followUpIntervalHours) ||
        body.followUpIntervalHours < 1 ||
        body.followUpIntervalHours > 8760)
    ) {
      res.status(400).json({
        error: "Interval follow-up harus bilangan bulat 1–8760 jam",
      });
      return;
    }
    if (
      body.autoCreateEnabled === undefined &&
      body.autoCreateThreshold === undefined &&
      body.staleDaysThreshold === undefined &&
      body.highValueThresholdIdr === undefined &&
      body.autoFollowUpEnabled === undefined &&
      body.followUpIntervalHours === undefined
    ) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }

    // Upsert the singleton row for this owner. We seed unspecified fields with
    // the defaults on first insert; on conflict we only set provided keys.
    const updateSet: Partial<typeof salesAssistantSettingsTable.$inferInsert> =
      {};
    if (body.autoCreateEnabled !== undefined)
      updateSet.autoCreateEnabled = body.autoCreateEnabled;
    if (body.autoCreateThreshold !== undefined)
      updateSet.autoCreateThreshold = body.autoCreateThreshold;
    if (body.staleDaysThreshold !== undefined)
      updateSet.staleDaysThreshold = body.staleDaysThreshold;
    if (body.highValueThresholdIdr !== undefined)
      updateSet.highValueThresholdIdr = body.highValueThresholdIdr;
    if (body.autoFollowUpEnabled !== undefined)
      updateSet.autoFollowUpEnabled = body.autoFollowUpEnabled;
    if (body.followUpIntervalHours !== undefined)
      updateSet.followUpIntervalHours = body.followUpIntervalHours;

    const [row] = await db
      .insert(salesAssistantSettingsTable)
      .values({
        ownerUserId: ownerId,
        autoCreateEnabled:
          body.autoCreateEnabled ?? DEFAULT_AUTO_CREATE_ENABLED,
        autoCreateThreshold:
          body.autoCreateThreshold ?? DEFAULT_AUTO_CREATE_THRESHOLD,
        staleDaysThreshold:
          body.staleDaysThreshold ?? DEFAULT_STALE_DAYS_THRESHOLD,
        highValueThresholdIdr:
          body.highValueThresholdIdr ?? DEFAULT_HIGH_VALUE_THRESHOLD_IDR,
        autoFollowUpEnabled:
          body.autoFollowUpEnabled ?? DEFAULT_AUTO_FOLLOW_UP_ENABLED,
        followUpIntervalHours:
          body.followUpIntervalHours ?? DEFAULT_FOLLOW_UP_INTERVAL_HOURS,
      })
      .onConflictDoUpdate({
        target: salesAssistantSettingsTable.ownerUserId,
        set: updateSet,
      })
      .returning();

    res.json({
      autoCreateEnabled: row!.autoCreateEnabled,
      autoCreateThreshold: row!.autoCreateThreshold,
      staleDaysThreshold: row!.staleDaysThreshold,
      highValueThresholdIdr: row!.highValueThresholdIdr,
      autoFollowUpEnabled: row!.autoFollowUpEnabled,
      followUpIntervalHours: row!.followUpIntervalHours,
    });
  }
);

// GET /sales/pipeline-health — high-risk (high-value + stale) open deals scoped
// to the caller. The risk math is the pure computePipelineHealth; we load the
// owner's Pipeline Health config (defaults if unset) and the caller's open
// opportunities, then return a summary + the high-risk id set (for badging the
// board). Best-effort: when there are high-risk deals we record ONE
// stage_recommendation audit event per owner per day (deduped on the date) so
// the audit trail isn't spammed by polling; failures there never break the read.
router.get(
  "/pipeline-health",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);

    const [cfgRow] = await db
      .select({
        staleDaysThreshold: salesAssistantSettingsTable.staleDaysThreshold,
        highValueThresholdIdr:
          salesAssistantSettingsTable.highValueThresholdIdr,
      })
      .from(salesAssistantSettingsTable)
      .where(eq(salesAssistantSettingsTable.ownerUserId, ownerId))
      .limit(1);
    const cfg = {
      staleDaysThreshold:
        cfgRow?.staleDaysThreshold ?? DEFAULT_STALE_DAYS_THRESHOLD,
      highValueThresholdIdr:
        cfgRow?.highValueThresholdIdr ?? DEFAULT_HIGH_VALUE_THRESHOLD_IDR,
    };

    // Only open deals can be at risk; scope by role (agents → own deals).
    const rows = await db
      .select({
        id: opportunitiesTable.id,
        status: opportunitiesTable.status,
        estimatedValueIdr: opportunitiesTable.estimatedValueIdr,
        lastActivityAt: opportunitiesTable.lastActivityAt,
      })
      .from(opportunitiesTable)
      .where(
        and(
          opportunityScopeWhere(ownerId, teamRole, uid),
          eq(opportunitiesTable.status, "open")
        )
      );

    const result = computePipelineHealth(rows, cfg, new Date());

    // Best-effort once-per-day audit of the recommendation. Deduped on the
    // UTC date string so repeated polling within a day inserts at most once.
    if (result.highRiskIds.length > 0) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const [existing] = await db
          .select({ id: salesAuditEventsTable.id })
          .from(salesAuditEventsTable)
          .where(
            and(
              eq(salesAuditEventsTable.ownerUserId, ownerId),
              eq(salesAuditEventsTable.eventType, "stage_recommendation"),
              sql`${salesAuditEventsTable.detail}->>'date' = ${today}`
            )
          )
          .limit(1);
        if (!existing) {
          await db.insert(salesAuditEventsTable).values({
            ownerUserId: ownerId,
            opportunityId: null,
            actorUserId: uid,
            eventType: "stage_recommendation",
            detail: {
              date: today,
              highRiskCount: result.summary.highRiskCount,
              highRiskValueIdr: result.summary.highRiskValueIdr,
              highRiskIds: result.highRiskIds,
            },
          });
        }
      } catch (err) {
        req.log.warn({ err }, "pipeline-health audit insert failed (ignored)");
      }
    }

    res.json(result);
  }
);

// GET /sales/audit — list recent sales audit events for the tenant, scoped to
// the caller's visibility. Always tenant-owner-scoped; an agent only sees
// events for opportunities they can access (or tenant-level events with no
// opportunity). An optional opportunityId filter is access-checked first.
router.get(
  "/audit",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);

    let limit = 100;
    if (req.query.limit != null) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        res.status(400).json({ error: "limit tidak valid" });
        return;
      }
      limit = parsed;
    }

    let opportunityFilter: number | null = null;
    if (req.query.opportunityId != null) {
      const parsed = Number(req.query.opportunityId);
      if (!Number.isInteger(parsed)) {
        res.status(400).json({ error: "opportunityId tidak valid" });
        return;
      }
      const [opp] = await db
        .select()
        .from(opportunitiesTable)
        .where(eq(opportunitiesTable.id, parsed))
        .limit(1);
      if (!opp || !canAccessOpportunity(opp, ownerId, teamRole, uid)) {
        res.status(404).json({ error: "Opportunity tidak ditemukan" });
        return;
      }
      opportunityFilter = parsed;
    }

    // Tenant-owner scope is always enforced. Non-privileged callers
    // (agent) only see events tied to opportunities they own, plus
    // tenant-level events that have no opportunity attached.
    const conditions = [eq(salesAuditEventsTable.ownerUserId, ownerId)];
    if (opportunityFilter != null) {
      conditions.push(eq(salesAuditEventsTable.opportunityId, opportunityFilter));
    } else if (teamRole === "agent") {
      conditions.push(
        sql`(${salesAuditEventsTable.opportunityId} IS NULL OR EXISTS (
          SELECT 1 FROM ${opportunitiesTable}
          WHERE ${opportunitiesTable.id} = ${salesAuditEventsTable.opportunityId}
            AND ${opportunitiesTable.assignedUserId} = ${uid}
        ))`
      );
    }

    const rows = await db
      .select()
      .from(salesAuditEventsTable)
      .where(and(...conditions))
      .orderBy(desc(salesAuditEventsTable.createdAt), desc(salesAuditEventsTable.id))
      .limit(limit);

    res.json(
      rows.map((e) => ({
        id: e.id,
        opportunityId: e.opportunityId,
        actorUserId: e.actorUserId,
        eventType: e.eventType,
        detail: e.detail ?? {},
        createdAt: e.createdAt.toISOString(),
      }))
    );
  }
);

// Serialize one follow-up row to the OpportunityFollowUp contract shape.
function serializeFollowUp(f: typeof opportunityFollowUpsTable.$inferSelect) {
  return {
    id: f.id,
    opportunityId: f.opportunityId,
    sequence: f.sequence,
    scheduledAt: f.scheduledAt.toISOString(),
    status: f.status,
    generatedMessage: f.generatedMessage,
    sentAt: f.sentAt ? f.sentAt.toISOString() : null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

// Load an opportunity + one of its follow-ups, enforcing the caller's access.
// Returns null (and writes the 404) when the opportunity is missing/invisible
// or the follow-up doesn't belong to it.
async function loadOwnedFollowUp(
  req: Request,
  res: Response,
  uid: number
): Promise<{
  opp: typeof opportunitiesTable.$inferSelect;
  followUp: typeof opportunityFollowUpsTable.$inferSelect;
} | null> {
  const ownerId = await resolveOwnerUserId(uid);
  const teamRole = await resolveTeamRole(uid);
  const id = Number(req.params.id);
  const followUpId = Number(req.params.followUpId);
  if (!Number.isInteger(id) || !Number.isInteger(followUpId)) {
    res.status(400).json({ error: "id tidak valid" });
    return null;
  }
  const [opp] = await db
    .select()
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, id))
    .limit(1);
  if (!opp || !canAccessOpportunity(opp, ownerId, teamRole, uid)) {
    res.status(404).json({ error: "Opportunity tidak ditemukan" });
    return null;
  }
  // Per-channel scope: editing/sending a follow-up is an action on the deal's
  // chat, so the caller must also be able to see that chat's channel (an agent
  // restricted to channel A must never send a WhatsApp touch into channel B).
  // canAccessOpportunity covers owner + assignment only; this closes the gap.
  if (!(await chatVisibleToUser(opp.chatId, ownerId, uid))) {
    res.status(404).json({ error: "Opportunity tidak ditemukan" });
    return null;
  }
  const [followUp] = await db
    .select()
    .from(opportunityFollowUpsTable)
    .where(
      and(
        eq(opportunityFollowUpsTable.id, followUpId),
        eq(opportunityFollowUpsTable.opportunityId, id)
      )
    )
    .limit(1);
  if (!followUp) {
    res.status(404).json({ error: "Follow-up tidak ditemukan" });
    return null;
  }
  return { opp, followUp };
}

// PATCH /sales/opportunities/:id/follow-ups/:followUpId — edit the drafted
// message and/or cancel a still-`pending` follow-up. Sent/cancelled/skipped
// touches are immutable (400). Editing follow-ups is an action on the deal →
// requires the "edit" opportunity permission.
router.patch(
  "/opportunities/:id/follow-ups/:followUpId",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const parsed = UpdateOpportunityFollowUpBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Data follow-up tidak valid" });
      return;
    }
    const body = parsed.data;
    if (body.generatedMessage === undefined && body.status === undefined) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }

    const loaded = await loadOwnedFollowUp(req, res, uid);
    if (!loaded) return;
    if (loaded.followUp.status !== "pending") {
      res
        .status(400)
        .json({ error: "Hanya follow-up terjadwal yang bisa diubah." });
      return;
    }

    const patch: Partial<typeof opportunityFollowUpsTable.$inferInsert> = {};
    if (body.generatedMessage !== undefined) {
      const text = body.generatedMessage?.trim() ?? "";
      patch.generatedMessage = text.length > 0 ? text : null;
      // A human queued a draft → this touch becomes their OPEN TASK, so the
      // auto-follow-up engine defers (won't auto-send or cancel it). Clearing
      // the draft releases it back to the engine.
      patch.manualDraft = text.length > 0;
    }
    if (body.status === "cancelled") patch.status = "cancelled";
    patch.updatedAt = new Date();

    // Re-assert `pending` at the SQL level so a concurrent send/sweep can't be
    // clobbered by a stale edit (TOCTOU).
    const [row] = await db
      .update(opportunityFollowUpsTable)
      .set(patch)
      .where(
        and(
          eq(opportunityFollowUpsTable.id, loaded.followUp.id),
          eq(opportunityFollowUpsTable.status, "pending")
        )
      )
      .returning();
    if (!row) {
      res.status(409).json({ error: "Follow-up sudah tidak terjadwal." });
      return;
    }
    res.json(serializeFollowUp(row));
  }
);

// POST /sales/opportunities/:id/follow-ups/:followUpId/send — send a pending
// follow-up NOW. Drafts the message via AI first when the row has none (a
// recommendation-only touch from the engine while Auto Follow-Up was off).
// Claim-first (pending→sent) so a concurrent sweep can't double-send; the send
// is rolled back to pending on failure. Mirrors the engine's send path.
router.post(
  "/opportunities/:id/follow-ups/:followUpId/send",
  requirePermission("opportunities", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);

    const loaded = await loadOwnedFollowUp(req, res, uid);
    if (!loaded) return;
    const { opp, followUp } = loaded;

    // Resolve the chat's OWN channel kind — only WhatsApp can send a follow-up.
    const [channel] = await db
      .select({ kind: channelsTable.kind })
      .from(channelsTable)
      .where(eq(channelsTable.id, opp.channelId))
      .limit(1);

    const decision = decideManualFollowUpSend({
      followUpStatus: followUp.status as FollowUpStatus,
      channelKind: channel?.kind ?? "",
    });
    if (!decision.ok) {
      if (decision.code === "not_pending") {
        res.status(409).json({ error: "Follow-up sudah tidak terjadwal." });
      } else {
        res
          .status(400)
          .json({ error: "Follow-up hanya bisa dikirim ke channel WhatsApp." });
      }
      return;
    }

    // Draft a message when the row has none (recommendation-only). 502 on
    // generation failure so the client can retry without a half-applied state.
    let messageText = followUp.generatedMessage?.trim() || "";
    let provider: string | null = null;
    let model: string | null = null;
    if (!messageText) {
      const draft = await generateFollowUpMessage({
        opportunity: opp,
        sequence: followUp.sequence,
      });
      if (!draft) {
        res.status(502).json({ error: "Gagal membuat pesan follow-up." });
        return;
      }
      messageText = draft.text;
      provider = draft.provider;
      model = draft.model;
    }

    // Claim the row (pending→sent) atomically; if nothing comes back another
    // path already settled it.
    const sentAt = new Date();
    const claimed = await db
      .update(opportunityFollowUpsTable)
      .set({ status: "sent", sentAt, generatedMessage: messageText, updatedAt: sentAt })
      .where(
        and(
          eq(opportunityFollowUpsTable.id, followUp.id),
          eq(opportunityFollowUpsTable.status, "pending")
        )
      )
      .returning();
    const claimedRow = claimed[0];
    if (!claimedRow) {
      res.status(409).json({ error: "Follow-up sudah tidak terjadwal." });
      return;
    }

    const tenant = await getOrCreateTenantSettings(ownerId);
    const ok = await sendFollowUpOnChannel(opp.channelId, opp.chatId, messageText, {
      min: tenant.replyDelayMin,
      max: tenant.replyDelayMax,
    });
    if (!ok) {
      // Roll the claim back so the touch stays actionable (manual retry / sweep).
      const [reverted] = await db
        .update(opportunityFollowUpsTable)
        .set({ status: "pending", sentAt: null, updatedAt: new Date() })
        .where(eq(opportunityFollowUpsTable.id, followUp.id))
        .returning();
      req.log.warn(
        { followUpId: followUp.id, channelId: opp.channelId },
        "manual follow-up send failed; rolled back to pending"
      );
      res.status(502).json({ error: "Gagal mengirim follow-up. Coba lagi." });
      void reverted;
      return;
    }

    // Advance the deal's activity clock so staleness/health reflect the touch.
    await db
      .update(opportunitiesTable)
      .set({ lastActivityAt: sentAt })
      .where(eq(opportunitiesTable.id, opp.id));
    await db.insert(salesAuditEventsTable).values({
      ownerUserId: ownerId,
      opportunityId: opp.id,
      actorUserId: uid,
      eventType: "follow_up_sent",
      detail: {
        sequence: followUp.sequence,
        manual: true,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    });
    res.json(serializeFollowUp(claimedRow));
  }
);

// GET /sales/forecast — weighted revenue forecast + win rate scoped to caller.
router.get(
  "/forecast",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const teamRole = await resolveTeamRole(uid);
    const scope = opportunityScopeWhere(ownerId, teamRole, uid);

    const rows = await db
      .select({
        status: opportunitiesTable.status,
        stageId: opportunitiesTable.stageId,
        estimatedValueIdr: opportunitiesTable.estimatedValueIdr,
        leadScore: opportunitiesTable.leadScore,
        createdAt: opportunitiesTable.createdAt,
        updatedAt: opportunitiesTable.updatedAt,
      })
      .from(opportunitiesTable)
      .where(scope);

    const stages = await db
      .select({ id: pipelineStagesTable.id, name: pipelineStagesTable.name })
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.ownerUserId, ownerId))
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));

    const result = computeSalesForecast(
      rows.map((r) => ({
        status: r.status as "open" | "won" | "lost",
        stageId: r.stageId,
        estimatedValueIdr: Number(r.estimatedValueIdr),
        leadScore: Number(r.leadScore),
        createdAt: r.createdAt ?? new Date(),
        updatedAt: r.updatedAt ?? new Date(),
      })),
      stages
    );
    res.json(result);
  }
);

export default router;
