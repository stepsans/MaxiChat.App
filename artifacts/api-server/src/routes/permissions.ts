import { Router } from "express";
import { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requireSuperAdmin } from "../lib/team-permissions";
import {
  getEffectivePermissions,
  getMatrixForOwner,
  saveMatrix,
  PERMISSION_MENUS,
  type PermissionMenu,
  getUserOverrides,
  saveUserOverrides,
  listTeamMembersForOwner,
  userIdsWithOverrides,
  getRoleDefaultsForOwner,
  type UserOverrides,
} from "../lib/role-permissions";
import {
  getAllowedChannelIds,
  setAllowedChannelIds,
  listTenantChannels,
} from "../lib/user-channel-access";

const router = Router();

const PermCellSchema = z.object({
  canView: z.boolean(),
  canCreate: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});

const MenuKeySchema = z.enum(
  PERMISSION_MENUS as unknown as [PermissionMenu, ...PermissionMenu[]]
);

// NOTE: must be partialRecord. In zod v4 `z.record` with an enum key is
// exhaustive (every menu key required); the editors send only changed cells,
// so a full record would reject partial payloads with "Invalid payload".
const RoleMatrixSchema = z.partialRecord(MenuKeySchema, PermCellSchema);

const UpdateMatrixSchema = z.object({
  supervisor: RoleMatrixSchema.optional(),
  agent: RoleMatrixSchema.optional(),
});

// GET /permissions — full editable matrix for the caller's team. Available
// to anyone signed in (supervisors / agents can view their own restrictions
// read-only on the frontend); only super_admin can PUT.
router.get("/", async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const matrix = await getMatrixForOwner(ownerId);
    res.json({ supervisor: matrix.supervisor, agent: matrix.agent });
  } catch (err) {
    req.log.error({ err }, "get permissions matrix failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /permissions — replace cells for one or both roles. Super admin only.
router.put("/", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const parsed = UpdateMatrixSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid permission matrix" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    await saveMatrix(ownerId, {
      supervisor: parsed.data.supervisor,
      agent: parsed.data.agent,
    });
    const matrix = await getMatrixForOwner(ownerId);
    res.json({ supervisor: matrix.supervisor, agent: matrix.agent });
  } catch (err) {
    req.log.error({ err }, "put permissions matrix failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Per-user permission overrides ----------

// partialRecord (not record): see RoleMatrixSchema note — only changed cells
// are sent, so an exhaustive record would 400 on every partial save.
const UserOverridesSchema = z.partialRecord(MenuKeySchema, PermCellSchema);
const UpdateUserPermissionSchema = z.object({
  // null = reset to role default (delete all overrides for this user)
  overrides: UserOverridesSchema.nullable(),
});

// Guard: only allow super_admin of the same tenant to manage a target user's
// permissions. Returns the target user's row when allowed, or sends a 403/404
// response (returns null to abort the handler).
async function requireOwnedTeamMember(
  req: import("express").Request,
  res: import("express").Response,
  targetUserId: number
): Promise<
  | {
      id: number;
      name: string | null;
      email: string;
      teamRole: string;
      parentUserId: number | null;
    }
  | null
> {
  const callerId = getSessionUserId(req);
  if (callerId == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  const ownerId = await resolveOwnerUserId(callerId);
  const [target] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      teamRole: usersTable.teamRole,
      parentUserId: usersTable.parentUserId,
    })
    .from(usersTable)
    .where(eq(usersTable.id, targetUserId))
    .limit(1);
  if (!target) {
    res.status(404).json({ error: "User tidak ditemukan" });
    return null;
  }
  // Target must be either the caller's owner self or a direct invitee.
  const inSameTeam =
    target.id === ownerId || target.parentUserId === ownerId;
  if (!inSameTeam) {
    res.status(403).json({ error: "User di luar tim Anda" });
    return null;
  }
  return target;
}

// GET /permissions/users — list team members with name/email/role + a flag
// indicating whether they have custom overrides. Super admin only.
router.get("/users", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const members = await listTeamMembersForOwner(ownerId);
    const customised = await userIdsWithOverrides(members.map((m) => m.id));
    res.json({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        teamRole: m.teamRole,
        hasOverrides: customised.has(m.id),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "list team-member permissions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /permissions/users/:userId — return roleDefault + overrides + effective
// for the target user. Super admin only. Super_admin targets get
// roleDefault=all-true and overrides={} (their cells aren't editable).
router.get(
  "/users/:userId",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const target = await requireOwnedTeamMember(req, res, targetId);
      if (!target) return;
      const callerId = getSessionUserId(req)!;
      const ownerId = await resolveOwnerUserId(callerId);
      const teamRole =
        target.teamRole === "supervisor" || target.teamRole === "agent"
          ? (target.teamRole as "supervisor" | "agent")
          : ("super_admin" as const);
      const roleDefault = await getRoleDefaultsForOwner(ownerId, teamRole);
      const overrides = await getUserOverrides(target.id);
      const effective = await getEffectivePermissions(target.id);
      res.json({
        user: {
          id: target.id,
          name: target.name,
          email: target.email,
          teamRole,
        },
        roleDefault,
        overrides,
        effective: effective.menus,
      });
    } catch (err) {
      req.log.error({ err }, "get user permissions failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT /permissions/users/:userId — replace overrides for the target user.
// Body `{overrides: null}` clears all overrides (reset to role default).
// Super admin only. Refuses to edit super_admin targets (their cells are
// hard-coded all-true and editing would be a confusing no-op).
router.put(
  "/users/:userId",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const target = await requireOwnedTeamMember(req, res, targetId);
      if (!target) return;
      if (
        target.teamRole !== "supervisor" &&
        target.teamRole !== "agent"
      ) {
        res.status(400).json({
          error: "Super Admin selalu memiliki akses penuh dan tidak dapat diatur",
        });
        return;
      }
      const parsed = UpdateUserPermissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }
      const overrides: UserOverrides = parsed.data.overrides ?? {};
      await saveUserOverrides(target.id, overrides);
      const callerId = getSessionUserId(req)!;
      const ownerId = await resolveOwnerUserId(callerId);
      const teamRole = target.teamRole as "supervisor" | "agent";
      const roleDefault = await getRoleDefaultsForOwner(ownerId, teamRole);
      const stored = await getUserOverrides(target.id);
      const effective = await getEffectivePermissions(target.id);
      res.json({
        user: {
          id: target.id,
          name: target.name,
          email: target.email,
          teamRole,
        },
        roleDefault,
        overrides: stored,
        effective: effective.menus,
      });
    } catch (err) {
      req.log.error({ err }, "save user permissions failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ---------- Per-user channel access (chat scope only) ----------

const UpdateChannelAccessSchema = z.object({
  channelIds: z.array(z.number().int().positive()).max(500),
});

// GET /permissions/users/:userId/channels — return the full list of channels
// in the tenant + which ones the user is allowed to see chats in.
router.get(
  "/users/:userId/channels",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const target = await requireOwnedTeamMember(req, res, targetId);
      if (!target) return;
      const callerId = getSessionUserId(req)!;
      const ownerId = await resolveOwnerUserId(callerId);
      const channels = await listTenantChannels(ownerId);
      const allowed = await getAllowedChannelIds(target.id);
      res.json({
        user: {
          id: target.id,
          name: target.name,
          email: target.email,
          teamRole: target.teamRole,
        },
        channels,
        allowedChannelIds: Array.from(allowed).sort((a, b) => a - b),
      });
    } catch (err) {
      req.log.error({ err }, "get user channel access failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT /permissions/users/:userId/channels — replace the user's chat-access
// allow-list. Empty array = no chats visible (deny-by-default).
// Refuses to edit super_admin targets — they always see every channel.
router.put(
  "/users/:userId/channels",
  requireSuperAdmin,
  async (req, res): Promise<void> => {
    try {
      const targetId = Number(req.params.userId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const target = await requireOwnedTeamMember(req, res, targetId);
      if (!target) return;
      if (target.teamRole !== "supervisor" && target.teamRole !== "agent") {
        res.status(400).json({
          error:
            "Super Admin selalu memiliki akses ke semua channel dan tidak dapat diatur",
        });
        return;
      }
      const parsed = UpdateChannelAccessSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }
      const callerId = getSessionUserId(req)!;
      const ownerId = await resolveOwnerUserId(callerId);
      const stored = await setAllowedChannelIds(
        target.id,
        ownerId,
        parsed.data.channelIds
      );
      const channels = await listTenantChannels(ownerId);
      res.json({
        user: {
          id: target.id,
          name: target.name,
          email: target.email,
          teamRole: target.teamRole,
        },
        channels,
        allowedChannelIds: stored.slice().sort((a, b) => a - b),
      });
    } catch (err) {
      req.log.error({ err }, "save user channel access failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /permissions/me — effective perms for the signed-in user. Used by the
// frontend to hide/disable buttons; matches the backend `requirePermission`
// gates so the two never drift.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const eff = await getEffectivePermissions(uid);
    res.json(eff);
  } catch (err) {
    req.log.error({ err }, "get my permissions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
