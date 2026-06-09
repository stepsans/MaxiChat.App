import type { Request, Response, NextFunction } from "express";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  plansTable,
  usersTable,
  pipelinesTable,
  pipelineStagesTable,
  opportunitiesTable,
} from "@workspace/db";
import { getSessionUserId } from "./auth";
import { resolveOwnerUserId } from "./seed";
import { isInfinityOwner } from "./infinity-owner";
import { getCurrentTeamRole, type TeamRole } from "./team-permissions";

// ===========================================================================
// AI Sales Assistant — Enterprise gate, default pipeline/stage seeding, and
// the agent-ownership scope fragment shared by every sales route.
// ===========================================================================

export async function ownerHasSalesAssistant(ownerId: number): Promise<boolean> {
  if (await isInfinityOwner(ownerId)) return true;
  const [row] = await db
    .select({ has: plansTable.hasAiSalesAssistant })
    .from(usersTable)
    .innerJoin(plansTable, eq(plansTable.key, usersTable.plan))
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  return row?.has ?? false;
}

export async function requireSalesAssistant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "not_signed_in" });
    return;
  }
  try {
    const ownerId = await resolveOwnerUserId(uid);
    if (!(await ownerHasSalesAssistant(ownerId))) {
      res.status(403).json({
        error:
          "Fitur AI Sales Assistant hanya tersedia pada paket Enterprise. Hubungi admin untuk mengaktifkannya.",
      });
      return;
    }
    if (!seededOwners.has(ownerId)) {
      await seedDefaultPipelines(ownerId);
      seededOwners.add(ownerId);
    }
    next();
  } catch (err) {
    req.log.error({ err }, "requireSalesAssistant check failed");
    res.status(500).json({ error: "Internal server error" });
  }
}

const seededOwners = new Set<number>();

export function markOwnerStagesUnseeded(ownerId: number): void {
  seededOwners.delete(ownerId);
}

// ---------------------------------------------------------------------------
// Default pipeline definitions
// ---------------------------------------------------------------------------

export const DEFAULT_SALES_PIPELINE = {
  name: "Pipeline Sales",
  pipelineType: "sales" as const,
  color: "#22c55e",
  isDefault: true,
  sortOrder: 0,
} as const;

export const DEFAULT_SERVICE_PIPELINE = {
  name: "Pipeline Service",
  pipelineType: "service" as const,
  color: "#3b82f6",
  isDefault: false,
  sortOrder: 1,
} as const;

export const DEFAULT_SALES_STAGES: ReadonlyArray<{
  name: string;
  isWon: boolean;
  isLost: boolean;
}> = [
  { name: "New Lead",       isWon: false, isLost: false },
  { name: "Inquiry",        isWon: false, isLost: false },
  { name: "Quotation Sent", isWon: false, isLost: false },
  { name: "Follow Up",      isWon: false, isLost: false },
  { name: "Negotiation",    isWon: false, isLost: false },
  { name: "Won",            isWon: true,  isLost: false },
  { name: "Lost",           isWon: false, isLost: true  },
];

export const DEFAULT_SERVICE_STAGES: ReadonlyArray<{
  name: string;
  isWon: boolean;
  isLost: boolean;
}> = [
  { name: "Permintaan Masuk",    isWon: false, isLost: false },
  { name: "Diagnosa",            isWon: false, isLost: false },
  { name: "Penawaran Service",   isWon: false, isLost: false },
  { name: "Dalam Pengerjaan",    isWon: false, isLost: false },
  { name: "Selesai",             isWon: true,  isLost: false },
  { name: "Dibatalkan",          isWon: false, isLost: true  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// Idempotently seed both default pipelines (Sales + Service) and their stages
// for an owner on first access. If the owner already has pipelines, skips.
// Returns all of the owner's pipelines with their stages.
export async function seedDefaultPipelines(ownerId: number): Promise<
  Array<{
    pipeline: typeof pipelinesTable.$inferSelect;
    stages: Array<typeof pipelineStagesTable.$inferSelect>;
  }>
> {
  const existingPipelines = await db
    .select()
    .from(pipelinesTable)
    .where(eq(pipelinesTable.ownerUserId, ownerId))
    .orderBy(asc(pipelinesTable.sortOrder), asc(pipelinesTable.id));

  // Always ensure both default pipelines exist (handles the case where
  // the migration backfilled only Pipeline Sales for legacy owners).
  await db
    .insert(pipelinesTable)
    .values([
      { ownerUserId: ownerId, ...DEFAULT_SALES_PIPELINE },
      { ownerUserId: ownerId, ...DEFAULT_SERVICE_PIPELINE },
    ])
    .onConflictDoNothing();

  // Fetch all pipelines (may have been created above or already existed).
  const pipelines = await db
    .select()
    .from(pipelinesTable)
    .where(eq(pipelinesTable.ownerUserId, ownerId))
    .orderBy(asc(pipelinesTable.sortOrder), asc(pipelinesTable.id));

  const result: Array<{
    pipeline: typeof pipelinesTable.$inferSelect;
    stages: Array<typeof pipelineStagesTable.$inferSelect>;
  }> = [];

  for (const pipeline of pipelines) {
    const existingStages = await db
      .select()
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.pipelineId, pipeline.id))
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));

    if (existingStages.length === 0) {
      const defaultStages =
        pipeline.pipelineType === "service"
          ? DEFAULT_SERVICE_STAGES
          : DEFAULT_SALES_STAGES;

      await db
        .insert(pipelineStagesTable)
        .values(
          defaultStages.map((s, i) => ({
            ownerUserId: ownerId,
            pipelineId: pipeline.id,
            name: s.name,
            sortOrder: i,
            isWon: s.isWon,
            isLost: s.isLost,
          }))
        )
        .onConflictDoNothing();
    }

    const stages = await db
      .select()
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.pipelineId, pipeline.id))
      .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));

    result.push({ pipeline, stages });
  }

  return result;
}

// Compatibility shim: callers that previously called seedDefaultStages(ownerId)
// and expected a flat list of stages now get the first (default) pipeline's
// stages. Background detection uses this to resolve the first stage.
export async function seedDefaultStages(
  ownerId: number
): Promise<Array<typeof pipelineStagesTable.$inferSelect>> {
  const pipelines = await seedDefaultPipelines(ownerId);
  const defaultPipeline =
    pipelines.find((p) => p.pipeline.isDefault) ?? pipelines[0];
  return defaultPipeline?.stages ?? [];
}

// Return the default pipeline for an owner (used by auto-detection to place
// new opportunities). Ensures pipelines are seeded before querying.
export async function getDefaultPipeline(
  ownerId: number
): Promise<typeof pipelinesTable.$inferSelect | null> {
  const pipelines = await seedDefaultPipelines(ownerId);
  return (
    pipelines.find((p) => p.pipeline.isDefault)?.pipeline ??
    pipelines[0]?.pipeline ??
    null
  );
}

// Return a pipeline by type for an owner (e.g. 'service' for service intents).
// Falls back to the default pipeline if no match.
export async function getPipelineByType(
  ownerId: number,
  pipelineType: string
): Promise<typeof pipelinesTable.$inferSelect | null> {
  await seedDefaultPipelines(ownerId);
  const [match] = await db
    .select()
    .from(pipelinesTable)
    .where(
      and(
        eq(pipelinesTable.ownerUserId, ownerId),
        eq(pipelinesTable.pipelineType, pipelineType),
        eq(pipelinesTable.isArchived, false)
      )
    )
    .orderBy(asc(pipelinesTable.sortOrder))
    .limit(1);
  if (match) return match;
  return getDefaultPipeline(ownerId);
}

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

export function opportunityScopeWhere(
  ownerId: number,
  teamRole: TeamRole,
  userId: number
): SQL {
  const base = eq(opportunitiesTable.ownerUserId, ownerId);
  if (teamRole === "agent") {
    return and(base, eq(opportunitiesTable.assignedUserId, userId))!;
  }
  return base;
}

export async function resolveTeamRole(userId: number): Promise<TeamRole> {
  return getCurrentTeamRole(userId);
}

export async function isValidAssignee(
  assignedUserId: number,
  ownerId: number
): Promise<boolean> {
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, assignedUserId),
        sql`COALESCE(${usersTable.parentUserId}, ${usersTable.id}) = ${ownerId}`
      )
    )
    .limit(1);
  return !!row;
}

export function canAccessOpportunity(
  opp: { ownerUserId: number; assignedUserId: number | null },
  ownerId: number,
  teamRole: TeamRole,
  userId: number
): boolean {
  if (opp.ownerUserId !== ownerId) return false;
  if (teamRole === "agent") return opp.assignedUserId === userId;
  return true;
}
