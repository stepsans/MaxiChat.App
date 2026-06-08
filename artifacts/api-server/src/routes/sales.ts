import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  pipelineStagesTable,
  opportunitiesTable,
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
} from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requirePermission } from "../lib/role-permissions";
import {
  requireSalesAssistant,
  seedDefaultStages,
  resolveTeamRole,
  opportunityScopeWhere,
  canAccessOpportunity,
  isValidAssignee,
} from "../lib/sales-assistant";
import { analyzeAndPersistChat } from "../lib/sales-insight";

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

function serializeStage(s: typeof pipelineStagesTable.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    sortOrder: s.sortOrder,
    isWon: s.isWon,
    isLost: s.isLost,
    color: s.color,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function serializeOpportunity(o: typeof opportunitiesTable.$inferSelect) {
  return {
    id: o.id,
    assignedUserId: o.assignedUserId,
    chatId: o.chatId,
    channelId: o.channelId,
    contactPhone: o.contactPhone,
    contactName: o.contactName,
    stageId: o.stageId,
    leadScore: o.leadScore,
    intentCategory: o.intentCategory,
    estimatedValueIdr: o.estimatedValueIdr,
    status: o.status,
    waitingStatus: o.waitingStatus,
    productInterest: o.productInterest,
    aiNotes: o.aiNotes,
    lastActivityAt: o.lastActivityAt ? o.lastActivityAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function serializeInsight(i: typeof salesInsightsTable.$inferSelect) {
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
  };
}

// Per-owner AI Sales Assistant config defaults. Inert by default: auto-create
// OFF (the AI only recommends) at a 70 threshold.
const DEFAULT_AUTO_CREATE_ENABLED = false;
const DEFAULT_AUTO_CREATE_THRESHOLD = 70;

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
// Pipeline stages (board columns). Seeded on first GET. Stages are tenant
// CONFIGURATION; create/edit/delete need the "edit"/"delete" opportunity perm.
// ---------------------------------------------------------------------------

// GET /sales/stages — list (seeds defaults on first access).
router.get(
  "/stages",
  requirePermission("opportunities", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const ownerId = await resolveOwner(req, res);
    if (ownerId == null) return;
    const stages = await seedDefaultStages(ownerId);
    res.json(stages.map(serializeStage));
  }
);

// POST /sales/stages — create a stage.
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
    try {
      const [row] = await db
        .insert(pipelineStagesTable)
        .values({
          ownerUserId: ownerId,
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

// DELETE /sales/stages/:id — delete a stage (opportunities in it become
// unstaged via the FK SET NULL).
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
    const [row] = await db
      .delete(pipelineStagesTable)
      .where(
        and(
          eq(pipelineStagesTable.id, id),
          eq(pipelineStagesTable.ownerUserId, ownerId)
        )
      )
      .returning({ id: pipelineStagesTable.id });
    if (!row) {
      res.status(404).json({ error: "Stage tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  }
);

// ---------------------------------------------------------------------------
// Opportunities (deals). Agents see only their own assigned deals.
// ---------------------------------------------------------------------------

// GET /sales/opportunities — list (scoped by role).
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
    const rows = await db
      .select()
      .from(opportunitiesTable)
      .where(and(...conds))
      .orderBy(desc(opportunitiesTable.updatedAt));
    res.json(rows.map(serializeOpportunity));
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

    try {
      const [row] = await db
        .insert(opportunitiesTable)
        .values({
          ownerUserId: ownerId,
          assignedUserId: body.assignedUserId ?? null,
          chatId: chat.id,
          channelId: chat.channelId,
          contactPhone: chat.phoneNumber,
          contactName: body.contactName ?? chat.contactName ?? null,
          stageId: body.stageId ?? null,
          leadScore: body.leadScore ?? 0,
          intentCategory: body.intentCategory ?? null,
          estimatedValueIdr: body.estimatedValueIdr ?? 0,
          status: body.status ?? "open",
          waitingStatus: body.waitingStatus ?? null,
          productInterest: body.productInterest ?? [],
          aiNotes: body.aiNotes ?? null,
          lastActivityAt: new Date(),
        })
        .returning();
      await db.insert(salesAuditEventsTable).values({
        ownerUserId: ownerId,
        opportunityId: row.id,
        actorUserId: getSessionUserId(req),
        eventType: "opportunity_created",
        detail: { source: "manual" },
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

// GET /sales/opportunities/:id — fetch one (role-scoped).
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
    const [row] = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, id))
      .limit(1);
    if (!row || !canAccessOpportunity(row, ownerId, teamRole, uid)) {
      res.status(404).json({ error: "Opportunity tidak ditemukan" });
      return;
    }
    res.json(serializeOpportunity(row));
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
    res.json(serializeInsight(row));
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
      res.json(serializeInsight(result.insight));
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
      body.autoCreateEnabled === undefined &&
      body.autoCreateThreshold === undefined
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

    const [row] = await db
      .insert(salesAssistantSettingsTable)
      .values({
        ownerUserId: ownerId,
        autoCreateEnabled:
          body.autoCreateEnabled ?? DEFAULT_AUTO_CREATE_ENABLED,
        autoCreateThreshold:
          body.autoCreateThreshold ?? DEFAULT_AUTO_CREATE_THRESHOLD,
      })
      .onConflictDoUpdate({
        target: salesAssistantSettingsTable.ownerUserId,
        set: updateSet,
      })
      .returning();

    res.json({
      autoCreateEnabled: row!.autoCreateEnabled,
      autoCreateThreshold: row!.autoCreateThreshold,
    });
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

export default router;
