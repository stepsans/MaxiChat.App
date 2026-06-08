import { Router } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { db, plansTable, addonsTable, usersTable } from "@workspace/db";
import {
  AdminCreatePlanBody,
  AdminUpdatePlanBody,
  AdminCreateAddonBody,
  AdminUpdateAddonBody,
} from "@workspace/api-zod";

// Admin-only CRUD for the subscription catalog (Hybrid model FASE 1).
// Mounted under /admin AFTER requireAdmin, so every caller here is already a
// verified platform admin. Plans/add-ons are pure DB catalog rows — no advisory
// lock is needed (there's no cross-row invariant like "keep one admin"); a
// plain unique index on plans.key guards against duplicate keys.
const router = Router();

function serializePlan(p: typeof plansTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function serializeAddon(a: typeof addonsTable.$inferSelect) {
  return {
    ...a,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// The generated Zod (from OpenAPI `type: integer`) only enforces `number`, so
// it would accept decimals. Money/quotas are whole-integer Rupiah/counts, so we
// re-check integer semantics here to keep the server matching the contract.
function planIntsValid(b: {
  priceIdr?: number;
  durationDays?: number;
  quotaUsers?: number;
  quotaChannels?: number;
  quotaTokens?: number;
  sortOrder?: number;
}): boolean {
  for (const v of [
    b.priceIdr,
    b.quotaUsers,
    b.quotaChannels,
    b.quotaTokens,
    b.sortOrder,
  ]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) return false;
  }
  if (
    b.durationDays !== undefined &&
    (!Number.isInteger(b.durationDays) || b.durationDays < 1)
  )
    return false;
  return true;
}

function addonIntsValid(b: {
  unitAmount?: number;
  priceIdr?: number;
  sortOrder?: number;
}): boolean {
  if (
    b.unitAmount !== undefined &&
    (!Number.isInteger(b.unitAmount) || b.unitAmount < 1)
  )
    return false;
  if (b.priceIdr !== undefined && (!Number.isInteger(b.priceIdr) || b.priceIdr < 0))
    return false;
  if (b.sortOrder !== undefined && (!Number.isInteger(b.sortOrder) || b.sortOrder < 0))
    return false;
  return true;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

// ---- Plans ---------------------------------------------------------------

router.get("/plans", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(plansTable)
      .orderBy(asc(plansTable.sortOrder), asc(plansTable.id));
    res.json(rows.map(serializePlan));
  } catch (err) {
    req.log.error({ err }, "adminListPlans failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/plans", async (req, res): Promise<void> => {
  try {
    const parsed = AdminCreatePlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input paket tidak valid" });
      return;
    }
    const body = parsed.data;
    if (!planIntsValid(body)) {
      res.status(400).json({ error: "Angka paket harus bilangan bulat valid" });
      return;
    }
    const existing = await db
      .select({ id: plansTable.id })
      .from(plansTable)
      .where(eq(plansTable.key, body.key))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: `Paket dengan key "${body.key}" sudah ada` });
      return;
    }
    try {
      const [row] = await db
        .insert(plansTable)
        .values({
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          priceIdr: body.priceIdr,
          durationDays: body.durationDays,
          quotaUsers: body.quotaUsers,
          quotaChannels: body.quotaChannels,
          quotaTokens: body.quotaTokens,
          isActive: body.isActive ?? true,
          sortOrder: body.sortOrder ?? 0,
          hasAiSalesAssistant: body.hasAiSalesAssistant ?? false,
        })
        .returning();
      res.status(201).json(serializePlan(row));
    } catch (err) {
      // Race: a concurrent create won the unique index between our pre-check
      // and insert. Translate the constraint violation back to a clean 409.
      if (isUniqueViolation(err)) {
        res
          .status(409)
          .json({ error: `Paket dengan key "${body.key}" sudah ada` });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "adminCreatePlan failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/plans/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID paket tidak valid" });
      return;
    }
    const parsed = AdminUpdatePlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input paket tidak valid" });
      return;
    }
    const body = parsed.data;
    if (!planIntsValid(body)) {
      res.status(400).json({ error: "Angka paket harus bilangan bulat valid" });
      return;
    }
    // The plan key is immutable (it links to users.plan), so it's never in the
    // update body. Build a patch of only the fields the caller actually sent.
    const patch: Partial<typeof plansTable.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.priceIdr !== undefined) patch.priceIdr = body.priceIdr;
    if (body.durationDays !== undefined) patch.durationDays = body.durationDays;
    if (body.quotaUsers !== undefined) patch.quotaUsers = body.quotaUsers;
    if (body.quotaChannels !== undefined)
      patch.quotaChannels = body.quotaChannels;
    if (body.quotaTokens !== undefined) patch.quotaTokens = body.quotaTokens;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (body.hasAiSalesAssistant !== undefined)
      patch.hasAiSalesAssistant = body.hasAiSalesAssistant;
    if (Object.keys(patch).length === 0) {
      const [current] = await db
        .select()
        .from(plansTable)
        .where(eq(plansTable.id, id))
        .limit(1);
      if (!current) {
        res.status(404).json({ error: "Paket tidak ditemukan" });
        return;
      }
      res.json(serializePlan(current));
      return;
    }
    const [row] = await db
      .update(plansTable)
      .set(patch)
      .where(eq(plansTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Paket tidak ditemukan" });
      return;
    }
    res.json(serializePlan(row));
  } catch (err) {
    req.log.error({ err }, "adminUpdatePlan failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/plans/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID paket tidak valid" });
      return;
    }
    const [plan] = await db
      .select({ id: plansTable.id, key: plansTable.key, name: plansTable.name })
      .from(plansTable)
      .where(eq(plansTable.id, id))
      .limit(1);
    if (!plan) {
      res.status(404).json({ error: "Paket tidak ditemukan" });
      return;
    }
    // A plan's key is referenced by users.plan. Hard-deleting an in-use plan
    // would orphan those tenants' plan lookups, so refuse and steer the admin
    // toward archiving (isActive=false) instead.
    const [inUse] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(eq(usersTable.plan, plan.key));
    if (inUse && inUse.count > 0) {
      res.status(409).json({
        error: `Paket "${plan.name}" masih dipakai ${inUse.count} tenant. Arsipkan (nonaktifkan) paket ini, jangan dihapus.`,
      });
      return;
    }
    await db.delete(plansTable).where(eq(plansTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "adminDeletePlan failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Add-ons -------------------------------------------------------------

router.get("/addons", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(addonsTable)
      .orderBy(asc(addonsTable.sortOrder), asc(addonsTable.id));
    res.json(rows.map(serializeAddon));
  } catch (err) {
    req.log.error({ err }, "adminListAddons failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/addons", async (req, res): Promise<void> => {
  try {
    const parsed = AdminCreateAddonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input add-on tidak valid" });
      return;
    }
    const body = parsed.data;
    if (!addonIntsValid(body)) {
      res
        .status(400)
        .json({ error: "Angka add-on harus bilangan bulat valid" });
      return;
    }
    const [row] = await db
      .insert(addonsTable)
      .values({
        type: body.type,
        name: body.name,
        unitAmount: body.unitAmount,
        priceIdr: body.priceIdr,
        isActive: body.isActive ?? true,
        sortOrder: body.sortOrder ?? 0,
      })
      .returning();
    res.status(201).json(serializeAddon(row));
  } catch (err) {
    req.log.error({ err }, "adminCreateAddon failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/addons/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID add-on tidak valid" });
      return;
    }
    const parsed = AdminUpdateAddonBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input add-on tidak valid" });
      return;
    }
    const body = parsed.data;
    if (!addonIntsValid(body)) {
      res
        .status(400)
        .json({ error: "Angka add-on harus bilangan bulat valid" });
      return;
    }
    const patch: Partial<typeof addonsTable.$inferInsert> = {};
    if (body.type !== undefined) patch.type = body.type;
    if (body.name !== undefined) patch.name = body.name;
    if (body.unitAmount !== undefined) patch.unitAmount = body.unitAmount;
    if (body.priceIdr !== undefined) patch.priceIdr = body.priceIdr;
    if (body.isActive !== undefined) patch.isActive = body.isActive;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (Object.keys(patch).length === 0) {
      const [current] = await db
        .select()
        .from(addonsTable)
        .where(eq(addonsTable.id, id))
        .limit(1);
      if (!current) {
        res.status(404).json({ error: "Add-on tidak ditemukan" });
        return;
      }
      res.json(serializeAddon(current));
      return;
    }
    const [row] = await db
      .update(addonsTable)
      .set(patch)
      .where(eq(addonsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Add-on tidak ditemukan" });
      return;
    }
    res.json(serializeAddon(row));
  } catch (err) {
    req.log.error({ err }, "adminUpdateAddon failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/addons/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID add-on tidak valid" });
      return;
    }
    const [row] = await db
      .delete(addonsTable)
      .where(eq(addonsTable.id, id))
      .returning({ id: addonsTable.id });
    if (!row) {
      res.status(404).json({ error: "Add-on tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "adminDeleteAddon failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
