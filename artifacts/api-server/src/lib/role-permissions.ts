import type { Request, Response, NextFunction } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  rolePermissionsTable,
  userPermissionsTable,
  usersTable,
} from "@workspace/db";
import { getSessionUserId } from "./auth";
import { resolveOwnerUserId } from "./seed";
import { getCurrentTeamRole, type TeamRole } from "./team-permissions";

// The UI sections that participate in the permission matrix. Keep this
// list in lock-step with the frontend matrix editor (Agents page) and the
// Layout sidebar filter — adding a menu here means it must also be added
// to the frontend constants.
export const PERMISSION_MENUS = [
  "knowledge",
  "products",
  "flows",
  "analytics",
  "credentials",
  "chats",
  "statuses",
  "settings",
  "channels",
  // View-only menus: only canView is meaningful (no create/edit/delete routes).
  "dashboard",
  "aiStudio",
  "usage",
  "aiReview",
] as const;
export type PermissionMenu = (typeof PERMISSION_MENUS)[number];

export const PERMISSION_ACTIONS = ["view", "create", "edit", "delete"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type RolePerm = {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

// Conservative defaults applied the first time a tenant's matrix is read.
// Super admin is intentionally absent — they're always-allow in code.
//
// Supervisor: full access to everything except destructive operations on
// integrations (credentials.delete) and team-wide settings.
// Agent: read-only on most menus; can only do work in chats + statuses.
function defaultMatrix(): Record<TeamRole, Record<PermissionMenu, RolePerm>> {
  const allow = (
    view: boolean,
    create: boolean,
    edit: boolean,
    del: boolean
  ): RolePerm => ({ canView: view, canCreate: create, canEdit: edit, canDelete: del });
  const sup = {
    knowledge: allow(true, true, true, true),
    products: allow(true, true, true, true),
    flows: allow(true, true, true, true),
    analytics: allow(true, false, false, false),
    // Integrations (credentials + sheet/drive sync) are owner-managed: a
    // supervisor may VIEW them but only the super_admin parent can change.
    credentials: allow(true, false, false, false),
    // Chats access is governed by per-channel access, not create/edit/delete.
    chats: allow(true, false, false, false),
    // Statuses has no edit route — view/create/delete only.
    statuses: allow(true, true, false, true),
    // Settings is view-only in the matrix; the general settings form is
    // super_admin-only and enforced in code, not via create/edit/delete.
    settings: allow(true, false, false, false),
    // Supervisor can add & connect their own channels; deletion stays with
    // the super_admin who centrally manages the tenant's channels.
    channels: allow(true, true, true, false),
    // View-only menus — supervisors see Dashboard & AI Studio by default;
    // Pemakaian Token & AI Review stay super_admin-only until granted.
    dashboard: allow(true, false, false, false),
    aiStudio: allow(true, false, false, false),
    usage: allow(false, false, false, false),
    aiReview: allow(false, false, false, false),
  } as const;
  const agt = {
    knowledge: allow(true, false, false, false),
    products: allow(true, false, false, false),
    flows: allow(false, false, false, false),
    analytics: allow(false, false, false, false),
    credentials: allow(false, false, false, false),
    // Chats access is governed by per-channel access, not create/edit/delete.
    chats: allow(true, false, false, false),
    statuses: allow(true, true, false, false),
    settings: allow(false, false, false, false),
    // Agent can add & connect their own channels (auto-granted access on
    // create); deletion stays super_admin-only — channels are centrally
    // managed by the tenant owner.
    channels: allow(true, true, true, false),
    // View-only menus — agents see none of these by default.
    dashboard: allow(false, false, false, false),
    aiStudio: allow(false, false, false, false),
    usage: allow(false, false, false, false),
    aiReview: allow(false, false, false, false),
  } as const;
  return {
    super_admin: Object.fromEntries(
      PERMISSION_MENUS.map((m) => [m, allow(true, true, true, true)])
    ) as Record<PermissionMenu, RolePerm>,
    supervisor: sup,
    agent: agt,
  };
}

type Matrix = Record<"supervisor" | "agent", Record<PermissionMenu, RolePerm>>;

// Build the matrix for the given owner. Reads any persisted overrides from
// role_permissions; for cells the owner has never customised we fall back
// to defaultMatrix() so the UI always has a fully-populated grid to show.
export async function getMatrixForOwner(ownerUserId: number): Promise<Matrix> {
  const rows = await db
    .select()
    .from(rolePermissionsTable)
    .where(eq(rolePermissionsTable.ownerUserId, ownerUserId));
  const defs = defaultMatrix();
  const out: Matrix = {
    supervisor: { ...defs.supervisor },
    agent: { ...defs.agent },
  };
  for (const r of rows) {
    if (r.role !== "supervisor" && r.role !== "agent") continue;
    if (!(PERMISSION_MENUS as readonly string[]).includes(r.menu)) continue;
    out[r.role as "supervisor" | "agent"][r.menu as PermissionMenu] = {
      canView: r.canView,
      canCreate: r.canCreate,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
    };
  }
  return out;
}

// Atomically replace the matrix for both roles (any role omitted is left
// untouched). Wrapping all upserts in one transaction prevents the "save
// only half the matrix" failure mode that an interrupted multi-statement
// flow would otherwise produce.
export async function saveMatrix(
  ownerUserId: number,
  payload: Partial<
    Record<"supervisor" | "agent", Partial<Record<PermissionMenu, RolePerm>>>
  >
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const role of ["supervisor", "agent"] as const) {
      const entries = payload[role];
      if (!entries) continue;
      for (const menu of Object.keys(entries) as PermissionMenu[]) {
        const p = entries[menu]!;
        await tx
          .insert(rolePermissionsTable)
          .values({
            ownerUserId,
            role,
            menu,
            canView: p.canView,
            canCreate: p.canCreate,
            canEdit: p.canEdit,
            canDelete: p.canDelete,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              rolePermissionsTable.ownerUserId,
              rolePermissionsTable.role,
              rolePermissionsTable.menu,
            ],
            set: {
              canView: p.canView,
              canCreate: p.canCreate,
              canEdit: p.canEdit,
              canDelete: p.canDelete,
              updatedAt: now,
            },
          });
      }
    }
  });
}

// Returns the effective permissions for the currently signed-in user —
// what the frontend uses to hide/disable buttons. Super admin always sees
// every cell as true regardless of any rows in role_permissions.
export async function getEffectivePermissions(
  userId: number
): Promise<{ teamRole: TeamRole; menus: Record<PermissionMenu, RolePerm> }> {
  const teamRole = await getCurrentTeamRole(userId);
  if (teamRole === "super_admin") {
    const all: RolePerm = {
      canView: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    };
    return {
      teamRole,
      menus: Object.fromEntries(PERMISSION_MENUS.map((m) => [m, all])) as Record<
        PermissionMenu,
        RolePerm
      >,
    };
  }
  const ownerId = await resolveOwnerUserId(userId);
  const matrix = await getMatrixForOwner(ownerId);
  const base = { ...matrix[teamRole] } as Record<PermissionMenu, RolePerm>;
  // Layer per-user overrides on top: a row in user_permissions REPLACES the
  // role default for that menu wholesale (matches the editor UX of toggling
  // a whole row at a time).
  const overrides = await getUserOverrides(userId);
  for (const menu of Object.keys(overrides) as PermissionMenu[]) {
    base[menu] = overrides[menu]!;
  }
  return { teamRole, menus: base };
}

// ---------- Per-user overrides ----------

export type UserOverrides = Partial<Record<PermissionMenu, RolePerm>>;

// Returns the user's stored overrides keyed by menu. Empty object = no
// overrides (user inherits role defaults verbatim).
export async function getUserOverrides(userId: number): Promise<UserOverrides> {
  const rows = await db
    .select()
    .from(userPermissionsTable)
    .where(eq(userPermissionsTable.userId, userId));
  const out: UserOverrides = {};
  for (const r of rows) {
    if (!(PERMISSION_MENUS as readonly string[]).includes(r.menu)) continue;
    out[r.menu as PermissionMenu] = {
      canView: r.canView,
      canCreate: r.canCreate,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
    };
  }
  return out;
}

// Replace ALL of userId's overrides with the given cells. Wrapped in a
// transaction so a partial write can't leave a half-applied matrix. Pass
// an empty object to clear all overrides (= "reset to role default").
//
// Concurrency: two simultaneous PUTs for the same user would otherwise
// race on the unique(userId, menu) constraint (one tx deletes, the other
// re-inserts, then the first re-inserts and dupes). We take a row-level
// lock on the parent users row at the top of the tx so the second writer
// waits for the first to commit — serialising the delete+insert pair
// without needing an upsert+prune dance.
export async function saveUserOverrides(
  userId: number,
  overrides: UserOverrides
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM ${usersTable} WHERE ${usersTable.id} = ${userId} FOR UPDATE`
    );
    await tx
      .delete(userPermissionsTable)
      .where(eq(userPermissionsTable.userId, userId));
    const entries = Object.entries(overrides) as Array<
      [PermissionMenu, RolePerm]
    >;
    if (entries.length === 0) return;
    await tx.insert(userPermissionsTable).values(
      entries.map(([menu, p]) => ({
        userId,
        menu,
        canView: p.canView,
        canCreate: p.canCreate,
        canEdit: p.canEdit,
        canDelete: p.canDelete,
        createdAt: now,
        updatedAt: now,
      }))
    );
  });
}

// Returns the set of userIds that have at least one override row. Used by
// the team-members list to show a "Customised" badge without N+1 queries.
export async function userIdsWithOverrides(
  userIds: number[]
): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ userId: userPermissionsTable.userId })
    .from(userPermissionsTable)
    .where(inArray(userPermissionsTable.userId, userIds));
  return new Set(rows.map((r) => r.userId));
}

// List team members (super_admin owner + invited supervisors/agents) under
// the same tenant as `ownerUserId`. Used to populate the user picker in
// the per-user permission editor.
export async function listTeamMembersForOwner(
  ownerUserId: number
): Promise<
  Array<{
    id: number;
    name: string | null;
    email: string;
    teamRole: TeamRole;
  }>
> {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      teamRole: usersTable.teamRole,
      parentUserId: usersTable.parentUserId,
    })
    .from(usersTable)
    .where(eq(usersTable.parentUserId, ownerUserId));
  const [owner] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      teamRole: usersTable.teamRole,
    })
    .from(usersTable)
    .where(eq(usersTable.id, ownerUserId))
    .limit(1);
  const normaliseRole = (tr: string | null | undefined): TeamRole =>
    tr === "supervisor" || tr === "agent" ? tr : "super_admin";
  const members = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    teamRole: normaliseRole(r.teamRole),
  }));
  if (owner) {
    members.unshift({
      id: owner.id,
      name: owner.name,
      email: owner.email,
      teamRole: normaliseRole(owner.teamRole),
    });
  }
  return members;
}

// Get the role-default cells for a given role (no user overrides applied).
// Convenience for the per-user editor to render "Reset to role default"
// previews.
export async function getRoleDefaultsForOwner(
  ownerUserId: number,
  role: TeamRole
): Promise<Record<PermissionMenu, RolePerm>> {
  if (role === "super_admin") {
    const all: RolePerm = {
      canView: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    };
    return Object.fromEntries(PERMISSION_MENUS.map((m) => [m, all])) as Record<
      PermissionMenu,
      RolePerm
    >;
  }
  const matrix = await getMatrixForOwner(ownerUserId);
  return matrix[role];
}

// Express middleware: gate a route on (menu, action). Super admin always
// passes. Cached perms are not used — we re-resolve per request so demotion
// / matrix edits take effect immediately on the next call.
export function requirePermission(menu: PermissionMenu, action: PermissionAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    try {
      const eff = await getEffectivePermissions(uid);
      const cell = eff.menus[menu];
      const ok =
        action === "view"
          ? cell.canView
          : action === "create"
            ? cell.canCreate
            : action === "edit"
              ? cell.canEdit
              : cell.canDelete;
      if (!ok) {
        res.status(403).json({
          error: "Anda tidak memiliki izin untuk melakukan aksi ini.",
        });
        return;
      }
      next();
    } catch (err) {
      req.log.error({ err, menu, action }, "permission check failed");
      res.status(500).json({ error: "Internal server error" });
    }
  };
}
