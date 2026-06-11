import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq, and, desc, ne, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  subscriptionsTable,
  emailOtpTable,
  platformSettingsTable,
} from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { requestEmailOtp, verifyEmailOtp, resendEmailOtp } from "../lib/email-otp";
import { verifyAgentInvitation } from "../lib/agent-invitation";
import { sendOtpEmail } from "../lib/email";
import { createMobileToken, revokeMobileToken } from "../lib/mobile-auth";
import { resolveOwnerUserId } from "../lib/seed";
import { ownerHasSalesAssistant } from "../lib/sales-assistant";
import { logger } from "../lib/logger";

const router = Router();
const otpLimit = rateLimit({
  windowMs: 3600_000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi dalam 1 jam." },
});

async function isOwnerEmail(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    const [row] = await db.select().from(platformSettingsTable)
      .where(eq(platformSettingsTable.key, "owner_email")).limit(1);
    const ownerEmail = row?.value?.toLowerCase().trim();
    if (ownerEmail && ownerEmail === normalizedEmail) return true;
  } catch {
    // platform_settings table may not exist yet — fall through to role check
  }
  // Always treat role=admin users as owners regardless of owner_email setting
  const [user] = await db.select({ role: usersTable.role })
    .from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  return user?.role === "admin";
}

async function setSession(req: import("express").Request, userId: number, role: string, teamRole: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  );
  req.session.userId = userId;
  req.session.userRole = role === "admin" ? "admin" : "user";
  req.session.teamRole =
    teamRole === "supervisor" || teamRole === "agent" ? teamRole : "super_admin";
  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve()))
  );
}

function serializeUser(user: typeof usersTable.$inferSelect, impersonating?: { mode: string } | null) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    teamRole: user.teamRole,
    name: user.name,
    companyName: user.companyName,
    profilePhotoUrl: user.profilePhotoUrl ?? null,
    mobilePhone: user.mobilePhone ?? null,
    plan: user.plan,
    parentUserId: user.parentUserId,
    isImpersonated: !!impersonating,
    impersonateMode: impersonating?.mode ?? null,
  };
}

// POST /auth/otp/request
router.post("/otp/request", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const purpose: "login" | "signup" = req.body?.purpose === "signup" ? "signup" : "login";
    if (!email || !email.includes("@")) { res.status(400).json({ error: "Email tidak valid." }); return; }

    // Owner: no email sent, just acknowledge
    if (await isOwnerEmail(email)) {
      res.json({ ok: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }); return;
    }

    if (purpose === "login") {
      const [user] = await db.select({ status: usersTable.status, emailVerifiedAt: usersTable.emailVerifiedAt })
        .from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (user && !user.emailVerifiedAt) {
        res.status(403).json({ error: "Email belum diverifikasi. Cek inbox untuk link undangan." }); return;
      }
      if (user && user.status === "disabled") {
        res.status(403).json({ error: "Akun dinonaktifkan. Hubungi Super Admin." }); return;
      }
    }

    const result = await requestEmailOtp(email, purpose, req.ip);
    if (!result.ok) { res.status(429).json({ error: result.error }); return; }

    try { await sendOtpEmail(email, result.otp!, purpose); }
    catch (err) { logger.error({ err, email }, "Failed to send OTP email"); }

    const resp: Record<string, unknown> = { ok: true, expiresAt: result.expiresAt.toISOString() };
    if (process.env.NODE_ENV !== "production") resp.devOtp = result.otp;
    res.json(resp);
  } catch (err) {
    logger.error({ err }, "POST /auth/otp/request failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/otp/verify
router.post("/otp/verify", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const otp = String(req.body?.otp ?? "").trim();
    const purpose: "login" | "signup" = req.body?.purpose === "signup" ? "signup" : "login";
    if (!email || !otp) { res.status(400).json({ error: "Email dan OTP wajib diisi." }); return; }

    // Owner: fixed OTP 161712
    if (await isOwnerEmail(email)) {
      if (otp !== "161712") { res.status(401).json({ error: "Kode OTP salah." }); return; }
      let [owner] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (!owner) {
        const [n] = await db.insert(usersTable).values({
          email, role: "admin", status: "active", teamRole: "super_admin", emailVerifiedAt: new Date(),
        }).returning();
        owner = n;
      }
      await setSession(req, owner.id, owner.role, owner.teamRole);
      res.json(serializeUser(owner));
      return;
    }

    const result = await verifyEmailOtp(email, otp, purpose);
    if (!result.ok) { res.status(401).json({ error: result.error }); return; }

    // Signup: OTP verified, continue to /auth/trial
    if (purpose === "signup") { res.json({ ok: true, otpVerified: true, email }); return; }

    // Login: create session
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) { res.status(401).json({ error: "Akun tidak ditemukan." }); return; }
    if (user.status === "disabled") { res.status(403).json({ error: "Akun dinonaktifkan." }); return; }
    if (user.status === "pending") { res.status(403).json({ error: "Akun belum aktif. Hubungi Super Admin." }); return; }

    await setSession(req, user.id, user.role, user.teamRole);
    const imp = (req.session as any).impersonating;
    res.json(serializeUser(user, imp));
  } catch (err) {
    logger.error({ err }, "POST /auth/otp/verify failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/otp/resend
router.post("/otp/resend", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const purpose: "login" | "signup" = req.body?.purpose === "signup" ? "signup" : "login";
    const result = await resendEmailOtp(email, purpose, req.ip);
    if (!result.ok) { res.status(429).json({ error: result.error }); return; }
    try { await sendOtpEmail(email, result.otp!, purpose); } catch (err) { logger.error({ err }, "Failed to resend OTP"); }
    const resp: Record<string, unknown> = { ok: true, expiresAt: result.expiresAt.toISOString() };
    if (process.env.NODE_ENV !== "production") resp.devOtp = result.otp;
    res.json(resp);
  } catch (err) {
    logger.error({ err }, "POST /auth/otp/resend failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/trial
router.post("/trial", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const name = String(req.body?.name ?? "").trim().slice(0, 120);
    const companyName = typeof req.body?.companyName === "string" ? req.body.companyName.trim().slice(0, 120) || null : null;
    if (!email || !name) { res.status(400).json({ error: "Email dan nama wajib diisi." }); return; }

    // Require signup OTP to be verified first
    const [verifiedOtp] = await db.select().from(emailOtpTable)
      .where(and(eq(emailOtpTable.email, email), eq(emailOtpTable.purpose, "signup")))
      .orderBy(desc(emailOtpTable.createdAt)).limit(1);
    if (!verifiedOtp?.verifiedAt) { res.status(400).json({ error: "Verifikasi OTP terlebih dahulu." }); return; }

    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing) { res.status(409).json({ error: "Email sudah terdaftar. Silakan login." }); return; }

    const [newUser] = await db.transaction(async (tx) => {
      const [u] = await tx.insert(usersTable).values({
        email, name, companyName, role: "user", status: "active",
        teamRole: "super_admin", emailVerifiedAt: new Date(), trialUsed: true,
      }).returning();
      await tx.insert(subscriptionsTable).values({
        userId: u.id, status: "trial", currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      }).onConflictDoNothing();
      return [u];
    });

    await setSession(req, newUser.id, newUser.role, newUser.teamRole);
    res.status(201).json(serializeUser(newUser));
  } catch (err) {
    logger.error({ err }, "POST /auth/trial failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/invite/verify
router.get("/invite/verify", async (req, res): Promise<void> => {
  try {
    const token = String(req.query?.token ?? "").trim();
    if (!token) { res.status(400).json({ error: "Token tidak valid." }); return; }
    const result = await verifyAgentInvitation(token);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    const appUrl = process.env.PUBLIC_URL || "https://app.maxichat.app";
    res.redirect(`${appUrl}/login?verified=1&email=${encodeURIComponent(result.email!)}`);
  } catch (err) {
    logger.error({ err }, "GET /auth/invite/verify failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") {
    res.json({ user: null });
    return;
  }
  try {
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!row || row.status !== "active") {
      req.session.destroy(() => {
        res.clearCookie("vjchat.sid");
        res.json({ user: null });
      });
      return;
    }
    const tr = row.teamRole === "supervisor" || row.teamRole === "agent" ? row.teamRole : "super_admin";
    if (req.session.teamRole !== tr) req.session.teamRole = tr;

    let companyName: string | null = row.companyName ?? null;
    if (!companyName && row.parentUserId) {
      const [owner] = await db.select({ companyName: usersTable.companyName }).from(usersTable)
        .where(eq(usersTable.id, row.parentUserId)).limit(1);
      companyName = owner?.companyName ?? null;
    }

    let hasAiSalesAssistant = false;
    try {
      const ownerId = await resolveOwnerUserId(row.id);
      hasAiSalesAssistant = await ownerHasSalesAssistant(ownerId);
    } catch (err) {
      logger.error({ err }, "/auth/me sales-assistant check failed");
    }

    const imp = (req.session as any).impersonating;
    res.json({
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        teamRole: tr,
        name: row.name,
        plan: row.plan,
        parentUserId: row.parentUserId,
        profilePhotoUrl: row.profilePhotoUrl ?? null,
        companyName,
        hasAiSalesAssistant,
        isImpersonated: !!imp,
        impersonateMode: imp?.mode ?? null,
      },
    });
  } catch (err) {
    logger.error({ err }, "/auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/me
router.patch("/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<{ name: string; companyName: string | null; mobilePhone: string | null }> = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (name.length < 1 || name.length > 80) { res.status(400).json({ error: "Nama harus 1–80 karakter" }); return; }
    patch.name = name;
  }
  if (body.mobilePhone !== undefined) {
    const raw = String(body.mobilePhone ?? "").trim();
    if (raw === "") { patch.mobilePhone = null; }
    else {
      if (raw.length < 6 || raw.length > 20 || !/^[+()\-\s\d]+$/.test(raw)) { res.status(400).json({ error: "Nomor HP tidak valid" }); return; }
      patch.mobilePhone = raw;
    }
  }
  if (body.companyName !== undefined) {
    const [row] = await db.select({ parentUserId: usersTable.parentUserId }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!row || row.parentUserId !== null) { res.status(403).json({ error: "Hanya super admin yang bisa mengubah nama perusahaan" }); return; }
    const cn = String(body.companyName ?? "").trim();
    if (cn.length > 120) { res.status(400).json({ error: "Nama perusahaan terlalu panjang" }); return; }
    patch.companyName = cn === "" ? null : cn;
  }
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Tidak ada perubahan" }); return; }
  try {
    await db.update(usersTable).set(patch).where(eq(usersTable.id, userId));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "PATCH /auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/me/photo
router.patch("/me/photo", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") { res.status(401).json({ error: "Unauthorized" }); return; }
  const raw = req.body?.profilePhotoUrl;
  if (typeof raw !== "string") { res.status(400).json({ error: "profilePhotoUrl harus string" }); return; }
  const url = raw.trim();
  if (url.length > 500) { res.status(400).json({ error: "URL foto terlalu panjang" }); return; }
  if (url !== "" && !url.startsWith("/api/media/") && !/^https?:\/\//.test(url)) { res.status(400).json({ error: "URL foto tidak valid" }); return; }
  try {
    await db.update(usersTable).set({ profilePhotoUrl: url || null }).where(eq(usersTable.id, userId));
    res.json({ profilePhotoUrl: url || null });
  } catch (err) {
    logger.error({ err }, "PATCH /auth/me/photo failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout
router.post("/logout", async (req, res): Promise<void> => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try { await revokeMobileToken(header.slice(7).trim()); } catch (err) { logger.error({ err }, "Mobile logout failed"); }
    res.json({ success: true }); return;
  }
  req.session.destroy((err) => {
    if (err) { logger.error({ err }, "Logout failed"); res.status(500).json({ error: "Internal server error" }); return; }
    res.clearCookie("vjchat.sid");
    res.json({ success: true });
  });
});

// DELETE /auth/me
const SELF_DELETE_LOCK_KEY = 0x564a4341;
router.delete("/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") { res.status(401).json({ error: "Tidak masuk" }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SELF_DELETE_LOCK_KEY})`);
      const [target] = await tx.select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
        .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (!target) return { error: { status: 404, message: "Akun tidak ditemukan" } as const };
      if (target.role === "admin" && target.status === "active") {
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(usersTable)
          .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active"), ne(usersTable.id, userId)));
        if (count === 0) return { error: { status: 403, message: "Anda admin platform terakhir. Tunjuk admin lain dulu sebelum menghapus akun." } as const };
      }
      await tx.delete(usersTable).where(eq(usersTable.id, userId));
      return { ok: true as const };
    });
    if ("error" in result && result.error) { res.status(result.error.status).json({ error: result.error.message }); return; }
    req.session.destroy((err) => {
      if (err) logger.error({ err }, "Session destroy after self-delete failed");
      res.clearCookie("vjchat.sid");
      res.json({ success: true });
    });
  } catch (err) {
    logger.error({ err }, "DELETE /auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Mobile login via OTP (email lookup + OTP verify)
router.post("/mobile-login", async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const otp = String(req.body?.otp ?? "").trim();
    if (!email || !otp) { res.status(400).json({ error: "Email dan OTP wajib diisi" }); return; }

    if (await isOwnerEmail(email)) {
      if (otp !== "161712") { res.status(401).json({ error: "Kode OTP salah" }); return; }
      const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (!user) { res.status(401).json({ error: "Akun tidak ditemukan" }); return; }
      const label = typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel.slice(0, 80) : null;
      const token = await createMobileToken(user.id, label);
      res.json({ token, user: serializeUser(user) }); return;
    }

    const result = await verifyEmailOtp(email, otp, "login");
    if (!result.ok) { res.status(401).json({ error: result.error }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || user.status !== "active") { res.status(401).json({ error: "Akun tidak ditemukan atau dinonaktifkan" }); return; }
    const label = typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel.slice(0, 80) : null;
    const token = await createMobileToken(user.id, label);
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    logger.error({ err }, "Mobile login failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Keep these exports for routes that still reference getEffectiveOwnerUserId
void getEffectiveOwnerUserId;

export default router;
