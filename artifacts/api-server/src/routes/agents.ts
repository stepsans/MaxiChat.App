import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { db, usersTable, plansTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { touchHeartbeat } from "../lib/round-robin";
import { isInfinityOwner } from "../lib/infinity-owner";
import { MEDIA_DIR } from "./whatsapp";

const router = Router();

// SaaS plan limits — number of *invited* team members (supervisor + agent
// rows) a super_admin may have. The super_admin itself is not counted toward
// the limit. The authoritative cap now lives in the DB `plans` table
// (quota_users), keyed by the plan key; this hardcoded map is only a fallback
// for when the row is missing (e.g. a custom key, or before the catalog seed).
const FALLBACK_PLAN_LIMITS = {
  basic: 2,
  pro: 5,
  business: 15,
  enterprise: 100,
} as const satisfies Record<string, number>;

type Plan = keyof typeof FALLBACK_PLAN_LIMITS;

// Resolve the invited-member cap for a plan key from the DB catalog, falling
// back to the hardcoded map (then to basic) so behavior never breaks if the
// `plans` row is absent.
async function planUserLimit(planKey: string): Promise<number> {
  const [row] = await db
    .select({ quotaUsers: plansTable.quotaUsers })
    .from(plansTable)
    .where(and(eq(plansTable.key, planKey), eq(plansTable.isActive, true)))
    .limit(1);
  if (row) return row.quotaUsers;
  return (
    FALLBACK_PLAN_LIMITS[planKey as Plan] ?? FALLBACK_PLAN_LIMITS.basic
  );
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}
function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

const TeamRoleSchema = z.enum(["supervisor", "agent"]);
const StatusSchema = z.enum(["active", "disabled"]);

// Mobile phone: required for new invites. Accepts +, digits, spaces, dashes,
// parens — frontend can format; we only check it's a plausible length.
const MobilePhoneSchema = z
  .string()
  .trim()
  .min(6, "Nomor HP terlalu pendek")
  .max(20, "Nomor HP terlalu panjang")
  .regex(/^[+()\-\s\d]+$/, "Nomor HP hanya boleh angka, +, -, spasi, atau ()");

const ProfilePhotoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || v.startsWith("/api/media/") || /^https?:\/\//.test(v), {
    message: "URL foto tidak valid",
  });

const CreateBody = z.object({
  email: z.string(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  teamRole: TeamRoleSchema,
  mobilePhone: MobilePhoneSchema,
  profilePhotoUrl: ProfilePhotoUrlSchema.optional(),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  teamRole: TeamRoleSchema.optional(),
  status: StatusSchema.optional(),
  mobilePhone: MobilePhoneSchema.optional(),
  // Pass "" to clear, otherwise must be a media URL.
  profilePhotoUrl: ProfilePhotoUrlSchema.optional(),
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
  // Raw users.plan key — passed straight to planUserLimit, which does the DB
  // catalog lookup and only falls back to the hardcoded map when the row is
  // missing. Never narrowed here, so custom/future plan keys resolve correctly.
  plan: string;
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
    return { ownerId: me.id, teamRole, plan: me.plan };
  }
  if (me.parentUserId == null) {
    // Orphaned invited account — treat as self for safety.
    return { ownerId: me.id, teamRole, plan: me.plan };
  }
  const [parent] = await db
    .select({ id: usersTable.id, plan: usersTable.plan })
    .from(usersTable)
    .where(eq(usersTable.id, me.parentUserId))
    .limit(1);
  return { ownerId: parent?.id ?? me.id, teamRole, plan: parent?.plan ?? me.plan };
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
    mobilePhone: row.mobilePhone,
    profilePhotoUrl: row.profilePhotoUrl,
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
    // Always read the owner row (super_admin) in full — we need its
    // assignmentMode AND we surface the owner as the first table entry so
    // it shows alongside invited teammates in the management UI.
    const [ownerRow] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, owner.ownerId))
      .limit(1);
    const assignmentMode =
      ownerRow?.assignmentMode === "round_robin" ? "round_robin" : "manual";
    // Prepend the super_admin row so the team table includes the owner.
    // usedAgents stays as the count of *invited* members (rows), since the
    // plan cap is about invited seats — the owner doesn't consume a seat.
    const agents = ownerRow
      ? [serialize(ownerRow), ...rows.map(serialize)]
      : rows.map(serialize);
    res.json({
      plan: owner.plan,
      maxAgents: await planUserLimit(owner.plan),
      usedAgents: rows.length,
      teamRole: owner.teamRole,
      assignmentMode,
      agents,
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
    // Owner Infinity accounts have an unlimited user quota, so skip the gate.
    if (!(await isInfinityOwner(owner.ownerId))) {
      const used = await countTeam(owner.ownerId);
      const maxAgents = await planUserLimit(owner.plan);
      if (used >= maxAgents) {
        res.status(409).json({
          error: `Kuota paket ${owner.plan} sudah penuh (${used}/${maxAgents}). Upgrade paket untuk menambah agen.`,
        });
        return;
      }
    }

    // Pre-check email uniqueness so the user sees a clear message even when
    // the conflict is with an account on another team (the UNIQUE index would
    // also catch it via onConflictDoNothing, but a friendly upfront message
    // matches what was specified in the brief).
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing) {
      res
        .status(409)
        .json({ error: "Email sudah terdaftar di sistem. Pakai email lain." });
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
        mobilePhone: parsed.data.mobilePhone,
        profilePhotoUrl: parsed.data.profilePhotoUrl || null,
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
      res
        .status(409)
        .json({ error: "Email sudah terdaftar di sistem. Pakai email lain." });
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
    if (parsed.data.mobilePhone !== undefined) patch.mobilePhone = parsed.data.mobilePhone;
    if (parsed.data.profilePhotoUrl !== undefined) {
      patch.profilePhotoUrl = parsed.data.profilePhotoUrl || null;
    }
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

// PUT /agents/settings — super_admin only. Currently only carries
// assignmentMode ("manual" | "round_robin"). The setting lives on the
// super_admin's own users row so it's tenant-scoped without a new table.
const SettingsBody = z.object({
  assignmentMode: z.enum(["manual", "round_robin"]),
});
router.put("/settings", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const owner = await resolveOwner(userId);
    if (!owner || owner.teamRole !== "super_admin") {
      res.status(403).json({ error: "Hanya super admin yang dapat mengubah pengaturan tim" });
      return;
    }
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body tidak valid", details: parsed.error.issues });
      return;
    }
    await db
      .update(usersTable)
      .set({ assignmentMode: parsed.data.assignmentMode })
      .where(eq(usersTable.id, owner.ownerId));
    res.json({ assignmentMode: parsed.data.assignmentMode });
  } catch (err) {
    req.log.error({ err }, "Update team settings failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /agents/heartbeat — every signed-in user pings this every ~30s while
// their tab is active so round-robin can tell who's actually online.
router.post("/heartbeat", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    await touchHeartbeat(userId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Heartbeat failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /agents/upload-photo — store an avatar image and return its public
// URL. Caller must be signed in; image is served via /api/media/<name>.
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
        cb(null, MEDIA_DIR);
      } catch (err) {
        cb(err as Error, MEDIA_DIR);
      }
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".png").toLowerCase();
      const safe = `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("File harus berupa gambar"));
      return;
    }
    cb(null, true);
  },
});
router.post("/upload-photo", photoUpload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "File tidak ditemukan" });
    return;
  }
  const url = `/api/media/${path.basename(req.file.path)}`;
  res.json({ url });
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
