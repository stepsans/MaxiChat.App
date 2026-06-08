import { Router } from "express";
import {
  db,
  usersTable,
  tenantResetAuditTable,
  type TenantResetSummary,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requireSuperAdmin } from "../lib/team-permissions";
import { resetTenant } from "../lib/tenant-reset";

const router = Router();

// Wipe ALL of the caller tenant's operational data. Super admin only; strictly
// owner-scoped (resolveOwnerUserId), irreversible. Writes an audit row.
router.post("/reset", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const summary = await resetTenant(ownerId, uid);
    res.json(summary);
  } catch (err) {
    req.log.error({ err }, "resetTenantDatabase failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// List recent reset events for the caller's tenant (most recent first).
router.get("/reset-audit", async (req, res): Promise<void> => {
  try {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const ownerId = await resolveOwnerUserId(uid);
    const rows = await db
      .select({
        id: tenantResetAuditTable.id,
        createdAt: tenantResetAuditTable.createdAt,
        summary: tenantResetAuditTable.summary,
        performedByEmail: usersTable.email,
      })
      .from(tenantResetAuditTable)
      .leftJoin(
        usersTable,
        eq(usersTable.id, tenantResetAuditTable.performedByUserId)
      )
      .where(eq(tenantResetAuditTable.ownerUserId, ownerId))
      .orderBy(desc(tenantResetAuditTable.createdAt))
      .limit(50);

    res.json(
      rows.map((r) => ({
        id: r.id,
        performedByEmail: r.performedByEmail ?? null,
        createdAt: r.createdAt.toISOString(),
        summary: r.summary as TenantResetSummary,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "listTenantResetAudit failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
