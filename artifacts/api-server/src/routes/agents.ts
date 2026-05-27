import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";

const router = Router();

// Hard-coded SaaS plan limits — number of *invited* team members
// (supervisor + agent rows) a super_admin may have. The super_admin itself
// is not counted toward the limit.
const PLAN_LIMITS = {
  basic: 2,
  pro: 5,
  business: 15,
} as const satisfies Record<string, number>;

type Plan = keyof typeof PLAN_LIMITS;
const PLANS = Object.keys(PLAN_LIMITS) as Plan[];

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}
function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

const TeamRoleSchema = z.enum(["supervisor", "agent"]);
const StatusSchema = z.enum(["active", "disabled"]);

const CreateBody = z.object({
  email: z.string(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  teamRole: TeamRoleSchema,
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  teamRole: TeamRoleSchema.optional(),
  status: StatusSchema.optional(),
  // Reset password — sent only when admin explicitly types a new one.
  password: z.string().min(8).max(200).optional(),
});

// Resolve who the "owner" account is for the current session:
//   super_admin → themselves
//   supervisor / agent → their parent_user_id (read-only for these roles
//   except `listAgents` which they're also allowed to call).
async function resolveOwner(userId: number): Promise<{
  ownerId: number;
  teamRole: "super_admin" | "supervisor" | "agent";
  plan: Plan;
} | null> {
  const [me] = await db
    .select({
      id: usersTable.id,
      teamRole: usersTable.teamRole,
      parentUserId: usersTable.parentUserId,
      plan: usersTable.plan,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!me) return null;
  const teamRole =
    me.teamRole === "supervisor" || me.teamRole === "agent"
      ? me.teamRole
      : "super_admin";
  if (teamRole === "super_admin") {
    const plan = (PLANS as string[]).includes(me.plan) ? (me.plan as Plan) : "basic";
    return { ownerId: me.id, teamRole, plan };
  }
  if (me.parentUserId == null) {
    // Orphaned invited account — treat as self for safety.
    return { ownerId: me.id, teamRole, plan: "basic" };
  }
  const [parent] = await db
    .select({ id: usersTable.id, plan: usersTable.plan })
    .from(usersTable)
    .where(eq(usersTable.id, me.parentUserId))
    .limit(1);
  const plan =
    parent && (PLANS as string[]).includes(parent.plan)
      ? (parent.plan as Plan)
      : "basic";
  return { ownerId: parent?.id ?? me.id, teamRole, plan };
}

async function countTeam(ownerId: number): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM users WHERE parent_user_id = ${ownerId}`
  );
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  return Number(row?.n ?? 0);
}

function serialize(row: typeof usersTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    teamRole: row.teamRole,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /agents — list team members + plan usage.
// Visible to super_admin (full list + own row separately) and supervisor /
// agent (read-only list of teammates).
router.get("/", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const owner = await resolveOwner(userId);
    if (!owner) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.parentUserId, owner.ownerId))
      .orderBy(usersTable.createdAt);
    res.json({
      plan: owner.plan,
      maxAgents: PLAN_LIMITS[owner.plan],
      usedAgents: rows.length,
      teamRole: owner.teamRole,
      agents: rows.map(serialize),
    });
  } catch (err) {
    req.log.error({ err }, "List agents failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /agents — invite a new team member. super_admin only.
router.post("/", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const owner = await resolveOwner(userId);
    if (!owner) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (owner.teamRole !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat menambah agen" });
      return;
    }
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body tidak valid", details: parsed.error.issues });
      return;
    }
    const email = normalizeEmail(parsed.data.email);
    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "Email tidak valid" });
      return;
    }

    // Plan-limit gate — count *current* members and compare to plan cap.
    const used = await countTeam(owner.ownerId);
    if (used >= PLAN_LIMITS[owner.plan]) {
      res.status(409).json({
        error: `Kuota paket ${owner.plan} sudah penuh (${used}/${PLAN_LIMITS[owner.plan]}). Upgrade paket untuk menambah agen.`,
      });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const inserted = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        role: "user",
        status: "active",
        name: parsed.data.name,
        parentUserId: owner.ownerId,
        teamRole: parsed.data.teamRole,
        // Inherit parent's plan column so a future "what plan am I on?" query
        // on the agent row returns something sensible, but resolveOwner()
        // always reads from the parent for limit enforcement.
        plan: owner.plan,
        approvedAt: new Date(),
      })
      .onConflictDoNothing({ target: usersTable.email })
      .returning();
    if (inserted.length === 0) {
      res.status(409).json({ error: "Email sudah terdaftar" });
      return;
    }
    res.status(201).json(serialize(inserted[0]));
  } catch (err) {
    req.log.error({ err }, "Create agent failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /agents/:id — update name / role / status / password. super_admin only.
router.patch("/:id", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const owner = await resolveOwner(userId);
    if (!owner || owner.teamRole !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat mengubah agen" });
      return;
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Id tidak valid" });
      return;
    }
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body tidak valid", details: parsed.error.issues });
      return;
    }
    const [target] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, targetId))
      .limit(1);
    if (!target || target.parentUserId !== owner.ownerId) {
      res.status(404).json({ error: "Agen tidak ditemukan" });
      return;
    }

    const patch: Partial<typeof usersTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.teamRole !== undefined) patch.teamRole = parsed.data.teamRole;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.password !== undefined) {
      patch.passwordHash = await bcrypt.hash(parsed.data.password, 12);
    }
    if (Object.keys(patch).length === 0) {
      res.json(serialize(target));
      return;
    }
    const [updated] = await db
      .update(usersTable)
      .set(patch)
      .where(eq(usersTable.id, targetId))
      .returning();
    res.json(serialize(updated));
  } catch (err) {
    req.log.error({ err }, "Update agent failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /agents/:id — super_admin only. ON DELETE CASCADE on parent_user_id
// would also delete child rows in the unlikely case of nested hierarchies.
router.delete("/:id", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const owner = await resolveOwner(userId);
    if (!owner || owner.teamRole !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat menghapus agen" });
      return;
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Id tidak valid" });
      return;
    }
    const result = await db
      .delete(usersTable)
      .where(
        and(eq(usersTable.id, targetId), eq(usersTable.parentUserId, owner.ownerId))
      )
      .returning({ id: usersTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Agen tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Delete agent failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper used by chats.ts to validate "user X may be assigned chats under
// owner Y" — same team or the owner themselves.
export async function isAssignableUnderOwner(
  ownerId: number,
  candidateUserId: number
): Promise<boolean> {
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, candidateUserId),
        or(
          eq(usersTable.id, ownerId),
          eq(usersTable.parentUserId, ownerId)
        )!
      )
    )
    .limit(1);
  return !!row;
}

export default router;
