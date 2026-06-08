import { Router } from "express";
import { and, eq, ne, sql, isNull, gte, lt } from "drizzle-orm";
import {
  db,
  usersTable,
  userWhatsappTable,
  aiUsageEventsTable,
} from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { computeBillingPeriod } from "../lib/billing-period";
import {
  AdminUpdatePricingBody,
  AdminRenewSubscriptionBody,
} from "@workspace/api-zod";
import {
  getPricing,
  updatePricing,
  computeOwnerBill,
  getOrCreateSubscription,
  computeRevenue,
  renewSubscription,
} from "../lib/billing";
import { getOrCreateTenantQuota } from "../lib/subscription-purchase";

// Serialize all role/status mutations through a single Postgres advisory
// lock so the "must keep one active admin" invariant can't be violated by
// concurrent requests (two admins demoting each other in parallel, etc).
// The lock auto-releases at transaction commit/rollback.
const ADMIN_MUTATION_LOCK_KEY = 0x564a4341; // 'VJCA'
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function withAdminLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK_KEY})`
    );
    return fn(tx);
  });
}

type AdminError = { status: number; message: string };
type Result<T> = { error: AdminError } | ({ error?: undefined } & T);

const router = Router();

// All routes here run *after* requireAdmin so we know the caller is an
// active admin. The caller's user id is still useful to prevent
// self-demotion / self-deletion.

router.get("/users", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
        approvedAt: usersTable.approvedAt,
        ownerPhone: userWhatsappTable.ownerPhone,
      })
      .from(usersTable)
      .leftJoin(
        userWhatsappTable,
        eq(userWhatsappTable.userId, usersTable.id)
      )
      .orderBy(usersTable.id);
    res.json(
      rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "adminListUsers failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const VALID_STATUS = new Set(["pending", "active", "disabled"]);
const VALID_ROLE = new Set(["user", "admin"]);

router.patch("/users/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const callerId = getSessionUserId(req);
    const nextStatus =
      typeof req.body?.status === "string" ? req.body.status : undefined;
    const nextRole =
      typeof req.body?.role === "string" ? req.body.role : undefined;
    if (!nextStatus && !nextRole) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }
    if (nextStatus && !VALID_STATUS.has(nextStatus)) {
      res.status(400).json({ error: "Status tidak valid" });
      return;
    }
    if (nextRole && !VALID_ROLE.has(nextRole)) {
      res.status(400).json({ error: "Role tidak valid" });
      return;
    }

    type UpdateOk = {
      updated: typeof usersTable.$inferSelect;
      ownerPhone: string | null;
    };
    const result = await withAdminLock<Result<UpdateOk>>(async (tx) => {
      const [target] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (!target) {
        return { error: { status: 404, message: "User tidak ditemukan" } };
      }

      // Refuse to demote or disable the caller themselves — they'd lock
      // themselves out mid-request.
      if (id === callerId) {
        if (nextRole && nextRole !== "admin") {
          return {
            error: {
              status: 403,
              message: "Tidak bisa menurunkan role diri sendiri",
            },
          };
        }
        if (nextStatus && nextStatus !== "active") {
          return {
            error: {
              status: 403,
              message: "Tidak bisa menonaktifkan diri sendiri",
            },
          };
        }
      }

      // Last-admin guard: if this change would leave zero active admins,
      // refuse. Runs inside the advisory-locked transaction so concurrent
      // admin mutations can't race past the count check.
      const wasActiveAdmin =
        target.role === "admin" && target.status === "active";
      const willBeActiveAdmin =
        (nextRole ?? target.role) === "admin" &&
        (nextStatus ?? target.status) === "active";
      if (wasActiveAdmin && !willBeActiveAdmin) {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.role, "admin"),
              eq(usersTable.status, "active"),
              ne(usersTable.id, id)
            )
          );
        if (count === 0) {
          return {
            error: {
              status: 403,
              message: "Minimal harus ada satu admin aktif",
            },
          };
        }
      }

      const patch: Record<string, unknown> = {};
      if (nextStatus) patch.status = nextStatus;
      if (nextRole) patch.role = nextRole;
      // Stamp approvedAt the first time we flip a pending account to active.
      if (
        nextStatus === "active" &&
        target.status !== "active" &&
        !target.approvedAt
      ) {
        patch.approvedAt = new Date();
      }

      const [updated] = await tx
        .update(usersTable)
        .set(patch)
        .where(eq(usersTable.id, id))
        .returning();

      const [ownerRow] = await tx
        .select({ ownerPhone: userWhatsappTable.ownerPhone })
        .from(userWhatsappTable)
        .where(eq(userWhatsappTable.userId, id))
        .limit(1);

      return { updated, ownerPhone: ownerRow?.ownerPhone ?? null };
    });

    if (result.error) {
      res.status(result.error.status).json({ error: result.error.message });
      return;
    }
    const { updated, ownerPhone } = result;
    res.json({
      id: updated.id,
      email: updated.email,
      role: updated.role,
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
      approvedAt: updated.approvedAt
        ? updated.approvedAt.toISOString()
        : null,
      ownerPhone,
    });
  } catch (err) {
    req.log.error({ err }, "adminUpdateUser failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/users/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const callerId = getSessionUserId(req);
    if (id === callerId) {
      res.status(403).json({ error: "Tidak bisa menghapus diri sendiri" });
      return;
    }
    const result = await withAdminLock<Result<{ ok: true }>>(async (tx) => {
      const [target] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (!target) {
        return { error: { status: 404, message: "User tidak ditemukan" } };
      }
      if (target.role === "admin" && target.status === "active") {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.role, "admin"),
              eq(usersTable.status, "active"),
              ne(usersTable.id, id)
            )
          );
        if (count === 0) {
          return {
            error: {
              status: 403,
              message: "Tidak bisa menghapus admin aktif terakhir",
            },
          };
        }
      }
      await tx.delete(usersTable).where(eq(usersTable.id, id));
      return { ok: true };
    });
    if (result.error) {
      res.status(result.error.status).json({ error: result.error.message });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "adminDeleteUser failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/ai-usage — per super admin (tenant owner) AI token usage for that
// owner's CURRENT billing period. The period is anchored on each owner's join
// date (createdAt day-of-month), so two owners reported here can be on
// different windows. Owners = users with parent_user_id IS NULL.
router.get("/ai-usage", async (req, res): Promise<void> => {
  try {
    const owners = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(isNull(usersTable.parentUserId))
      .orderBy(usersTable.id);

    const now = new Date();
    const rows = await Promise.all(
      owners.map(async (o) => {
        const { start, end } = computeBillingPeriod(o.createdAt, now);
        const [agg] = await db
          .select({
            promptTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.promptTokens}),0)::int`,
            completionTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.completionTokens}),0)::int`,
            totalTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.totalTokens}),0)::int`,
            requestCount: sql<number>`COUNT(*)::int`,
          })
          .from(aiUsageEventsTable)
          .where(
            and(
              eq(aiUsageEventsTable.userId, o.id),
              gte(aiUsageEventsTable.createdAt, start),
              lt(aiUsageEventsTable.createdAt, end)
            )
          );
        return {
          userId: o.id,
          email: o.email,
          name: o.name ?? null,
          joinedAt: o.createdAt.toISOString(),
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          promptTokens: agg?.promptTokens ?? 0,
          completionTokens: agg?.completionTokens ?? 0,
          totalTokens: agg?.totalTokens ?? 0,
          requestCount: agg?.requestCount ?? 0,
        };
      })
    );

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "adminAiUsage failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----- Usage-based pricing (global singleton) -----

router.get("/pricing", async (req, res): Promise<void> => {
  try {
    const pricing = await getPricing();
    res.json(pricing);
  } catch (err) {
    req.log.error({ err }, "adminGetPricing failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/pricing", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdatePricingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    // Money is whole Indonesian Rupiah — reject any non-integer (or negative)
    // value. The generated validator only checks number/min(0), so enforce the
    // integer rule here at the API boundary.
    const allInts = Object.values(parsed.data).every(
      (v) => Number.isInteger(v) && v >= 0
    );
    if (!allInts) {
      res
        .status(400)
        .json({ error: "Harga harus berupa angka bulat (Rupiah) ≥ 0" });
      return;
    }
    const adminId = getSessionUserId(req) ?? null;
    const pricing = await updatePricing(parsed.data, adminId);
    res.json(pricing);
  } catch (err) {
    req.log.error({ err }, "adminUpdatePricing failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Per-tenant subscription, live usage and computed monthly bill. One row per
// owner (parent_user_id IS NULL).
router.get("/billing", async (req, res): Promise<void> => {
  try {
    const owners = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
      })
      .from(usersTable)
      .where(and(isNull(usersTable.parentUserId), ne(usersTable.role, "admin")))
      .orderBy(usersTable.id);

    const rows = await Promise.all(
      owners.map(async (o) => {
        const [subscription, bill, quota] = await Promise.all([
          getOrCreateSubscription(o.id),
          computeOwnerBill(o.id),
          getOrCreateTenantQuota(o.id),
        ]);
        return {
          userId: o.id,
          email: o.email,
          name: o.name ?? null,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          storageLimit: quota?.storageLimit ?? 0,
          usage: bill.usage,
          breakdown: bill.breakdown,
        };
      })
    );

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "adminListBilling failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Platform-wide revenue: MRR/ARR/ARPU, tenant counts and the daily spend trend.
router.get("/revenue", async (req, res): Promise<void> => {
  try {
    const rawDays = Number(req.query.days);
    const days =
      Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365
        ? Math.floor(rawDays)
        : 30;
    const summary = await computeRevenue(days);
    res.json(summary);
  } catch (err) {
    req.log.error({ err }, "adminGetRevenue failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Renew / suspend / correct a tenant's subscription. "Mark paid" is
// { status: "active", extendMonths: 1 }, which unblocks the tenant instantly.
router.patch("/subscriptions/:userId", async (req, res): Promise<void> => {
  try {
    const ownerId = Number(req.params.userId);
    if (!Number.isInteger(ownerId) || ownerId <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    const parsed = AdminRenewSubscriptionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (
      parsed.data.status == null &&
      parsed.data.extendMonths == null &&
      !parsed.data.setUnlimited
    ) {
      res.status(400).json({
        error: "Provide at least one of status, extendMonths or setUnlimited",
      });
      return;
    }

    // The tenant must be an existing owner (parent_user_id IS NULL) and not the
    // platform admin (role="admin") — admins are not billable tenants.
    const [owner] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, ownerId),
          isNull(usersTable.parentUserId),
          ne(usersTable.role, "admin")
        )
      )
      .limit(1);
    if (!owner) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const updated = await renewSubscription(ownerId, {
      status: parsed.data.status,
      extendMonths: parsed.data.extendMonths,
      setUnlimited: parsed.data.setUnlimited,
    });
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "adminRenewSubscription failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
