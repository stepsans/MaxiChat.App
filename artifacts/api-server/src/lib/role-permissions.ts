import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db, rolePermissionsTable } from "@workspace/db";
import { getSessionUserId } from "./auth";
import { resolveOwnerUserId } from "./seed";
import { getCurrentTeamRole, type TeamRole } from "./team-permissions";

// The 8 UI sections that participate in the permission matrix. Keep this
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
    credentials: allow(true, true, true, false),
    chats: allow(true, true, true, true),
    statuses: allow(true, true, true, true),
    settings: allow(true, false, true, false),
  } as const;
  const agt = {
    knowledge: allow(true, false, false, false),
    products: allow(true, false, false, false),
    flows: allow(false, false, false, false),
    analytics: allow(false, false, false, false),
    credentials: allow(false, false, false, false),
    chats: allow(true, true, true, false),
    statuses: allow(true, true, false, false),
    settings: allow(false, false, false, false),
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
  return { teamRole, menus: matrix[teamRole] };
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
