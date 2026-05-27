import { Router } from "express";
import { z } from "zod/v4";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requireSuperAdmin } from "../lib/team-permissions";
import {
  getEffectivePermissions,
  getMatrixForOwner,
  saveMatrix,
  PERMISSION_MENUS,
  type PermissionMenu,
} from "../lib/role-permissions";

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

const RoleMatrixSchema = z.record(MenuKeySchema, PermCellSchema);

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
