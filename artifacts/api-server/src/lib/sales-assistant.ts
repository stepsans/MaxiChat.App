import type { Request, Response, NextFunction } from "express";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  plansTable,
  usersTable,
  pipelineStagesTable,
  opportunitiesTable,
} from "@workspace/db";
import { getSessionUserId } from "./auth";
import { resolveOwnerUserId } from "./seed";
import { isInfinityOwner } from "./infinity-owner";
import { getCurrentTeamRole, type TeamRole } from "./team-permissions";

// ===========================================================================
// AI Sales Assistant — Enterprise gate, default-stage seeding, and the
// agent-ownership scope fragment shared by every sales route.
// ===========================================================================

// Does the tenant OWNER's plan include the AI Sales Assistant entitlement?
// Infinity owners always pass — the bypass is resolved through the same
// isInfinityOwner chokepoint the effective-subscription path uses, so granting
// Infinity to an account unlocks the assistant everywhere from one place.
// Pass an already-resolved owner id (use resolveOwnerUserId for team members).
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

// Express middleware: 403 any AI Sales Assistant call from a tenant whose plan
// lacks the entitlement. Mounted on every sales router. Resolves the owner from
// the session (team members roll up to their owner) on each request so a plan
// change / Infinity toggle takes effect immediately.
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
    // Seed the default pipeline stages on the tenant's first AI Sales Assistant
    // access — ANY /sales/* endpoint, not just GET /sales/stages. seedDefaultStages
    // is idempotent; the per-process cache avoids re-querying on every request.
    if (!seededOwners.has(ownerId)) {
      await seedDefaultStages(ownerId);
      seededOwners.add(ownerId);
    }
    next();
  } catch (err) {
    req.log.error({ err }, "requireSalesAssistant check failed");
    res.status(500).json({ error: "Internal server error" });
  }
}

// Per-process cache of owners whose default stages have been ensured this boot.
// seedDefaultStages itself is idempotent against the DB; this just skips the
// extra read on the hot path. Cleared for an owner by tenant-reset (which wipes
// their stages) so the next access re-seeds.
const seededOwners = new Set<number>();

// Called by tenant-reset after it wipes a tenant's pipeline stages, so the
// next AI Sales Assistant access re-seeds the defaults.
export function markOwnerStagesUnseeded(ownerId: number): void {
  seededOwners.delete(ownerId);
}

// The seven default pipeline stages every tenant starts with. Order is stable
// (index = sortOrder); Won/Lost are the terminal columns.
export const DEFAULT_SALES_STAGES: ReadonlyArray<{
  name: string;
  isWon: boolean;
  isLost: boolean;
}> = [
  { name: "New Lead", isWon: false, isLost: false },
  { name: "Inquiry", isWon: false, isLost: false },
  { name: "Quotation Sent", isWon: false, isLost: false },
  { name: "Follow Up", isWon: false, isLost: false },
  { name: "Negotiation", isWon: false, isLost: false },
  { name: "Won", isWon: true, isLost: false },
  { name: "Lost", isWon: false, isLost: true },
];

// Idempotently seed the default stages for an owner on first access. If the
// tenant already has any stage we leave their board untouched (they may have
// added/removed/reordered). Concurrency-safe: the per-name unique index +
// onConflictDoNothing makes a racing double-seed a no-op. Returns the owner's
// current stages ordered for display.
export async function seedDefaultStages(
  ownerId: number
): Promise<(typeof pipelineStagesTable.$inferSelect)[]> {
  const existing = await db
    .select()
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.ownerUserId, ownerId))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
  if (existing.length > 0) return existing;

  await db
    .insert(pipelineStagesTable)
    .values(
      DEFAULT_SALES_STAGES.map((s, i) => ({
        ownerUserId: ownerId,
        name: s.name,
        sortOrder: i,
        isWon: s.isWon,
        isLost: s.isLost,
      }))
    )
    .onConflictDoNothing();

  return db
    .select()
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.ownerUserId, ownerId))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
}

// The reusable authorization fragment for opportunity reads/writes. Layers the
// tenant-owner scope with the per-role rule:
//   * super_admin / supervisor → all of the owner's opportunities
//   * agent                    → only opportunities assigned to that agent
// Returns a Drizzle WHERE condition other phases compose into their queries.
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

// Convenience: resolve the caller's effective team role (DB-backed, not the
// session cache) so route handlers can build the scope fragment.
export async function resolveTeamRole(userId: number): Promise<TeamRole> {
  return getCurrentTeamRole(userId);
}

// Validate that an opportunity assignee belongs to THIS tenant before we write
// it. A team member's owner = COALESCE(parent_user_id, id); the owner may also
// assign a deal to themselves. Rejects non-existent ids and cross-tenant ids
// (which would otherwise create invalid ownership / RBAC-bypass semantics).
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

// Helper used by per-id opportunity routes: can the caller (with the given
// role) act on this specific opportunity row? Mirrors opportunityScopeWhere.
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
