import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq, and, ne, sql, desc, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  subscriptionsTable,
  trustedDevicesTable,
} from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId, requireAuth } from "../lib/auth";
import {
  issueTrustedDevice,
  consumeTrustedDevice,
  revokeTrustedDevice,
  deviceLabelFromUA,
  TD_COOKIE,
} from "../lib/trusted-device";
import { requestEmailOtp, verifyEmailOtp, resendEmailOtp } from "../lib/email-otp";
import { verifyAgentInvitation, getAppUrl } from "../lib/agent-invitation";
import { sendOtpEmail, sendVerificationEmail } from "../lib/email";
import { createEmailVerification, consumeEmailVerification } from "../lib/email-verification";
import { canonicalizeEmail, isDisposableEmail } from "../lib/email-canonical";
import { createMobileToken, revokeMobileToken } from "../lib/mobile-auth";
import { resolveOwnerUserId } from "../lib/seed";
import { provisionTrialQuota } from "../lib/subscription-purchase";
import { ownerHasSalesAssistant } from "../lib/sales-assistant";
import { logger } from "../lib/logger";

const router = Router();

const otpLimit = rateLimit({
  windowMs: 3600_000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi dalam 1 jam." },
});

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

// Trial length committed at email-verification (link click) for owners.
// Owner-confirmed: 14 days.
const TRIAL_DURATION_MS = 14 * 86_400_000;

// Issue a fresh single-use verification link and email it. Returns the
// dev-only verify URL when no email provider is configured (so local/dev can
// click through without an inbox). Never throws — email failures are logged
// and surfaced via devVerifyUrl in non-production.
async function issueVerificationLink(
  userId: number,
  email: string,
  name: string | null
): Promise<{ devVerifyUrl?: string }> {
  const { token } = await createEmailVerification(userId);
  const appUrl = await getAppUrl();
  const verifyUrl = `${appUrl}/verify-email?token=${token}&email=${encodeURIComponent(email)}`;
  const { devVerifyUrl } = await sendVerificationEmail({ to: email, name, verifyUrl });
  return { devVerifyUrl };
}

// Set the trusted-device cookie (web). httpOnly + Secure(prod) + SameSite=Lax.
function setTdCookie(res: import("express").Response, token: string, expiresAt: Date): void {
  res.cookie(TD_COOKIE, token, {
    httpOnly: true,
    secure:
      process.env.COOKIE_SECURE != null
        ? process.env.COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

// POST /auth/otp/request
router.post("/otp/request", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    if (!email || !email.includes("@")) { res.status(400).json({ error: "Email tidak valid." }); return; }

    // Login OTP only. Signup goes through the email link-verification flow
    // (/auth/signup → /auth/verify-email), never an OTP.
    const [user] = await db
      .select({
        id: usersTable.id,
        status: usersTable.status,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        name: usersTable.name,
        parentUserId: usersTable.parentUserId,
      })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    // Unregistered → never send an OTP; steer to signup.
    if (!user) {
      res.status(404).json({
        reason: "email_not_registered",
        error: "Email belum terdaftar. Silakan daftar dulu.",
        redirect: "/signup",
      });
      return;
    }
    if (user.status === "disabled") {
      res.status(403).json({ reason: "account_disabled", error: "Akun dinonaktifkan. Hubungi Super Admin." });
      return;
    }
    // Not yet verified → re-issue the correct activation link (NOT an OTP).
    // Invited team members (parentUserId != null) get an AGENT INVITATION link
    // (/invite/verify); self-signup owners get the email-verification link
    // (/verify-email). Sending the wrong one leaves invited members unable to
    // activate, because /auth/verify-email only flips rows that are still
    // status='pending' and invited rows are created 'active'.
    if (!user.emailVerifiedAt || user.status === "pending") {
      try {
        if (user.parentUserId !== null) {
          const { createAgentInvitation, getAppUrl } = await import("../lib/agent-invitation");
          const { sendAgentInvitationEmail } = await import("../lib/email");
          const [ownerRow] = await db
            .select({ name: usersTable.name, email: usersTable.email })
            .from(usersTable)
            .where(eq(usersTable.id, user.parentUserId))
            .limit(1);
          const { token } = await createAgentInvitation(user.id, user.parentUserId, email);
          await sendAgentInvitationEmail(
            email,
            ownerRow?.name || ownerRow?.email || "Super Admin",
            token,
            await getAppUrl()
          );
        } else {
          await issueVerificationLink(user.id, email, user.name);
        }
      } catch (err) {
        logger.error({ err, email }, "Failed to re-issue activation link");
      }
      res.status(403).json({
        reason: "email_not_verified",
        error: "Email belum diverifikasi. Kami kirim ulang link aktivasi ke email kamu.",
      });
      return;
    }

    // FAST-PATH: a valid trusted device skips OTP and logs in directly.
    // Web sends the mc_td cookie; mobile sends the X-Trusted-Device header.
    const tdFromCookie = (req as any).cookies?.[TD_COOKIE] as string | undefined;
    const tdFromHeader = req.get("x-trusted-device") || undefined;
    const rawTd = tdFromCookie ?? tdFromHeader;
    if (rawTd) {
      const rotated = await consumeTrustedDevice(
        user.id, rawTd, req.get("user-agent") || undefined, req.ip ?? undefined
      );
      if (rotated) {
        const [full] = await db.select().from(usersTable).where(eq(usersTable.id, user.id)).limit(1);
        if (full && full.status === "active") {
          // Mobile (header, no cookie) → mint a fresh bearer token + rotated TD token.
          if (tdFromHeader && !tdFromCookie) {
            const token = await createMobileToken(full.id, deviceLabelFromUA(req.get("user-agent")));
            res.json({ trusted: true, token, trustedDeviceToken: rotated.token, user: serializeUser(full) });
            return;
          }
          // Web → create session + rotate the cookie.
          await setSession(req, full.id, full.role, full.teamRole);
          setTdCookie(res, rotated.token, rotated.expiresAt);
          res.json({ trusted: true, user: serializeUser(full) });
          return;
        }
      }
    }

    const result = await requestEmailOtp(email, "login", req.ip);
    if (!result.ok) { res.status(429).json({ error: result.error }); return; }

    try { await sendOtpEmail(email, result.otp!, "login"); }
    catch (err) { logger.error({ err, email }, "Failed to send OTP email"); }

    const resp: Record<string, unknown> = { trusted: false, ok: true, expiresAt: result.expiresAt.toISOString() };
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
    if (!email || !otp) { res.status(400).json({ error: "Email dan OTP wajib diisi." }); return; }

    const result = await verifyEmailOtp(email, otp, "login");
    if (!result.ok) { res.status(401).json({ error: result.error }); return; }

    // Login: create session
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) { res.status(401).json({ error: "Akun tidak ditemukan." }); return; }
    if (user.status === "disabled") { res.status(403).json({ error: "Akun dinonaktifkan." }); return; }
    if (user.status === "pending") { res.status(403).json({ error: "Akun belum aktif. Hubungi Super Admin." }); return; }

    await setSession(req, user.id, user.role, user.teamRole);

    // Remember this device (default ON) → issue trusted-device cookie (30d).
    if (req.body?.rememberDevice !== false) {
      try {
        const td = await issueTrustedDevice(
          user.id,
          deviceLabelFromUA(req.get("user-agent")),
          req.get("user-agent") || undefined,
          req.ip ?? undefined
        );
        setTdCookie(res, td.token, td.expiresAt);
      } catch (err) { logger.error({ err }, "Failed to issue trusted device (web)"); }
    }

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
    const result = await resendEmailOtp(email, "login", req.ip);
    if (!result.ok) { res.status(429).json({ error: result.error }); return; }
    try { await sendOtpEmail(email, result.otp!, "login"); } catch (err) { logger.error({ err }, "Failed to resend OTP"); }
    const resp: Record<string, unknown> = { ok: true, expiresAt: result.expiresAt.toISOString() };
    if (process.env.NODE_ENV !== "production") resp.devOtp = result.otp;
    res.json(resp);
  } catch (err) {
    logger.error({ err }, "POST /auth/otp/resend failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/signup — self-register an owner. Creates a PENDING account and
// emails a verification link. No session, no OTP, no trial yet — the trial is
// committed only when the link is clicked (/auth/verify-email).
router.post("/signup", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    const name = String(req.body?.name ?? "").trim().slice(0, 120);
    const companyName = typeof req.body?.companyName === "string"
      ? req.body.companyName.trim().slice(0, 120) || null : null;
    const mobilePhone = typeof req.body?.mobilePhone === "string"
      ? req.body.mobilePhone.trim().slice(0, 20) || null : null;
    if (!email || !email.includes("@") || !name) {
      res.status(400).json({ error: "Email dan nama wajib diisi." }); return;
    }

    // Anti-abuse (trial self-signup only): block disposable inboxes.
    if (isDisposableEmail(email)) {
      res.status(400).json({
        reason: "disposable_email",
        error: "Gunakan email bisnis/permanen untuk mendaftar trial.",
      });
      return;
    }

    // Canonical form catches +alias and Gmail-dot tricks. The trial gate keys
    // on it, not raw email, so johndoe@ / john.doe+x@ count as the same person.
    const canonical = canonicalizeEmail(email);
    const [trialed] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.emailCanonical, canonical), eq(usersTable.trialUsed, true)))
      .limit(1);
    if (trialed) {
      res.status(409).json({ reason: "trial_already_used", error: "Email sudah pernah trial." });
      return;
    }

    const [existing] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        status: usersTable.status,
        trialUsed: usersTable.trialUsed,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (existing) {
      // Already trialed → hard block (only an admin grant-trial can reopen).
      if (existing.trialUsed) {
        res.status(409).json({ reason: "trial_already_used", error: "Email sudah pernah trial." });
        return;
      }
      // Active/verified but not trialed (e.g. invited member) → just log in.
      if (existing.emailVerifiedAt || existing.status !== "pending") {
        res.status(409).json({ error: "Email sudah terdaftar. Silakan login." });
        return;
      }
      // Pending & un-trialed → idempotent re-issue of the verification link.
      let devVerifyUrl: string | undefined;
      try { ({ devVerifyUrl } = await issueVerificationLink(existing.id, email, existing.name)); }
      catch (err) { logger.error({ err, email }, "Failed to re-issue signup verification link"); }
      res.status(201).json({
        id: existing.id, email, status: "pending",
        message: "Link verifikasi dikirim ulang. Cek email kamu.",
        devVerifyUrl: devVerifyUrl ?? null,
      });
      return;
    }

    const [user] = await db
      .insert(usersTable)
      .values({
        email, emailCanonical: canonical, name, companyName, mobilePhone,
        role: "user", status: "pending", teamRole: "super_admin",
        // emailVerifiedAt stays null + trialUsed false until the link is clicked.
      })
      .returning();

    let devVerifyUrl: string | undefined;
    try { ({ devVerifyUrl } = await issueVerificationLink(user.id, email, name)); }
    catch (err) { logger.error({ err, email }, "Failed to send signup verification link"); }

    res.status(201).json({
      id: user.id, email, status: "pending",
      message: "Akun dibuat. Cek email untuk verifikasi.",
      devVerifyUrl: devVerifyUrl ?? null,
    });
  } catch (err) {
    logger.error({ err }, "POST /auth/signup failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/verify-email — consume a verification token, activate the
// account (idempotent), and for owners commit the trial. Never creates a
// session: the user logs in afterwards via email OTP.
router.post("/verify-email", async (req, res): Promise<void> => {
  try {
    const token = String(req.body?.token ?? "").trim();
    if (!token) { res.status(400).json({ error: "Token wajib diisi." }); return; }

    const consumed = await consumeEmailVerification(token);
    if (!consumed.ok) { res.status(400).json({ error: consumed.error }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, consumed.userId)).limit(1);
    if (!user) { res.status(400).json({ error: "Akun tidak ditemukan." }); return; }
    // A disabled account's old link must never reactivate it.
    if (user.status === "disabled") { res.status(400).json({ error: "Akun dinonaktifkan." }); return; }

    // Idempotent activation: set emailVerifiedAt if missing, and promote a
    // still-pending row to active. Safe for already-active invited members that
    // somehow received a stale /verify-email link before FIX 2A shipped.
    await db
      .update(usersTable)
      .set({
        status: user.status === "pending" ? "active" : user.status,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      })
      .where(eq(usersTable.id, user.id));

    // Commit trial — owners only (parent NULL, not platform admin), once.
    const isOwner = user.parentUserId === null && user.role !== "admin";
    if (isOwner && !user.trialUsed) {
      const trialEnd = new Date(Date.now() + TRIAL_DURATION_MS);
      await db.transaction(async (tx) => {
        await tx
          .insert(subscriptionsTable)
          .values({ userId: user.id, status: "trial", currentPeriodEnd: trialEnd })
          .onConflictDoUpdate({
            target: subscriptionsTable.userId,
            set: {
              status: "trial",
              currentPeriodEnd: trialEnd,
              dunningStartedAt: null,
              graceUntil: null,
              updatedAt: new Date(),
            },
          });
        await tx.update(usersTable).set({ trialUsed: true }).where(eq(usersTable.id, user.id));
        // Grant the entry-level token plafon for the trial so the AI hard-block
        // (spec C1) applies during trial too. Window = trial period; anchor not
        // locked yet (locks at first paid conversion).
        await provisionTrialQuota(user.id, trialEnd, tx);
      });
    }

    // No session — frontend redirects to /login for the OTP step.
    res.json({ verified: true, email: user.email });
  } catch (err) {
    logger.error({ err }, "POST /auth/verify-email failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/resend-verification — re-send the verification link. Silent
// no-op (still ok:true) for unknown or already-verified emails so the
// endpoint never reveals which addresses exist.
router.post("/resend-verification", otpLimit, async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").toLowerCase().trim();
    if (!email || !email.includes("@")) { res.status(400).json({ error: "Email tidak valid." }); return; }

    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name, status: usersTable.status, emailVerifiedAt: usersTable.emailVerifiedAt })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (!user || user.emailVerifiedAt || user.status !== "pending") {
      res.json({ ok: true });
      return;
    }

    let devVerifyUrl: string | undefined;
    try { ({ devVerifyUrl } = await issueVerificationLink(user.id, email, user.name)); }
    catch (err) { logger.error({ err, email }, "Failed to resend verification link"); }
    res.json({ ok: true, devVerifyUrl: devVerifyUrl ?? null });
  } catch (err) {
    logger.error({ err }, "POST /auth/resend-verification failed");
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
    const appUrl = await getAppUrl();
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

    const result = await verifyEmailOtp(email, otp, "login");
    if (!result.ok) { res.status(401).json({ error: result.error }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || user.status !== "active") { res.status(401).json({ error: "Akun tidak ditemukan atau dinonaktifkan" }); return; }
    const label = typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel.slice(0, 80) : null;
    const token = await createMobileToken(user.id, label);

    // Remember this device (default ON) → return a trusted-device token the
    // client stores in SecureStore and replays as X-Trusted-Device on next login.
    let trustedDeviceToken: string | undefined;
    if (req.body?.rememberDevice !== false) {
      try {
        const td = await issueTrustedDevice(
          user.id,
          label || deviceLabelFromUA(req.get("user-agent")),
          req.get("user-agent") || undefined,
          req.ip ?? undefined
        );
        trustedDeviceToken = td.token;
      } catch (err) { logger.error({ err }, "Failed to issue trusted device (mobile)"); }
    }

    res.json({ token, user: serializeUser(user), trustedDeviceToken });
  } catch (err) {
    logger.error({ err }, "Mobile login failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/devices — list the current user's active trusted devices.
router.get("/devices", requireAuth, async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  try {
    const rows = await db
      .select({
        id: trustedDevicesTable.id,
        label: trustedDevicesTable.label,
        lastUsedAt: trustedDevicesTable.lastUsedAt,
        createdAt: trustedDevicesTable.createdAt,
        expiresAt: trustedDevicesTable.expiresAt,
      })
      .from(trustedDevicesTable)
      .where(and(eq(trustedDevicesTable.userId, userId), isNull(trustedDevicesTable.revokedAt)))
      .orderBy(desc(trustedDevicesTable.lastUsedAt));
    res.json({ devices: rows });
  } catch (err) {
    logger.error({ err }, "GET /auth/devices failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/devices/:id/revoke — revoke one of the current user's devices.
router.post("/devices/:id/revoke", requireAuth, async (req, res): Promise<void> => {
  const userId = getSessionUserId(req)!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Id tidak valid" }); return; }
  try {
    const ok = await revokeTrustedDevice(userId, id);
    res.json({ ok });
  } catch (err) {
    logger.error({ err }, "POST /auth/devices/:id/revoke failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Keep these exports for routes that still reference getEffectiveOwnerUserId
void getEffectiveOwnerUserId;

export default router;
