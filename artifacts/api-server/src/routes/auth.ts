import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq, and, isNull, gt, desc } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import {
  db,
  usersTable,
  emailVerificationTokensTable,
} from "@workspace/db";
import { sendVerificationEmail, emailSenderConfigured } from "../lib/email";
import {
  loginLimiter,
  signupLimiter,
  verifyEmailLimiter,
  resendVerificationLimiter,
} from "../lib/rate-limit";

const router = Router();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}
function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

// Mirror the password rule advertised in the UI (≥8 chars, an uppercase,
// a digit, a symbol). Re-checking here guarantees no client bypass.
function isStrongPassword(p: string): boolean {
  if (p.length < 8 || p.length > 200) return false;
  if (!/[A-Z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  if (!/[^A-Za-z0-9]/.test(p)) return false;
  return true;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildVerifyUrl(req: import("express").Request, token: string): string {
  // Canonical origin must come from configuration, never from the
  // inbound Host header (which is attacker-influenced in many proxy
  // setups → host-header poisoning that would steer victims to an
  // attacker domain and capture tokens). In production we therefore
  // require PUBLIC_URL to be set explicitly. In development we accept
  // the request host as a convenience so the flow "just works" locally.
  const configured = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (configured) {
    return `${configured}/verify-email?token=${encodeURIComponent(token)}`;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_URL is required in production to build verification links"
    );
  }
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/verify-email?token=${encodeURIComponent(token)}`;
}

async function issueVerificationTokenAndSend(
  req: import("express").Request,
  user: { id: number; email: string; name: string | null }
): Promise<string | undefined> {
  // Invalidate any older un-used tokens for this user first so the new
  // link is the only one that works. We mark them used rather than
  // deleting — keeps an audit trail of resends.
  await db
    .update(emailVerificationTokensTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokensTable.userId, user.id),
        isNull(emailVerificationTokensTable.usedAt)
      )
    );

  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.insert(emailVerificationTokensTable).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const verifyUrl = buildVerifyUrl(req, token);
  const result = await sendVerificationEmail({
    to: user.email,
    name: user.name,
    verifyUrl,
  });
  return result.devVerifyUrl;
}

router.post("/login", loginLimiter, async (req, res): Promise<void> => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!email || !password) {
      res.status(400).json({ error: "Email dan password wajib diisi" });
      return;
    }
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (!user) {
      res.status(401).json({ error: "Email atau password salah" });
      return;
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Email atau password salah" });
      return;
    }
    // Verification gate. Seed/invited accounts (created before the
    // verification feature, or by an admin invite) have their email
    // implicitly trusted: we treat status="active" + null verifiedAt as
    // already-verified to avoid breaking existing rows.
    if (user.status === "pending" && !user.emailVerifiedAt) {
      res.status(403).json({
        error: "Email belum diverifikasi. Cek inbox Anda atau minta link baru.",
        reason: "email_not_verified",
        email: user.email,
      });
      return;
    }
    if (user.status === "pending") {
      res.status(403).json({
        error:
          "Akun Anda masih menunggu persetujuan admin. Silakan hubungi admin.",
      });
      return;
    }
    if (user.status !== "active") {
      res.status(403).json({ error: "Akun Anda dinonaktifkan." });
      return;
    }
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userRole = user.role === "admin" ? "admin" : "user";
    req.session.teamRole =
      user.teamRole === "supervisor" || user.teamRole === "agent"
        ? user.teamRole
        : "super_admin";
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      teamRole: req.session.teamRole,
      name: user.name,
      plan: user.plan,
      parentUserId: user.parentUserId,
    });
  } catch (err) {
    req.log.error({ err }, "Login failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Logout failed");
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    res.clearCookie("vjchat.sid");
    res.json({ success: true });
  });
});

router.get("/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") {
    res.json({ user: null });
    return;
  }
  try {
    const [row] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        status: usersTable.status,
        teamRole: usersTable.teamRole,
        name: usersTable.name,
        plan: usersTable.plan,
        parentUserId: usersTable.parentUserId,
        profilePhotoUrl: usersTable.profilePhotoUrl,
        companyName: usersTable.companyName,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!row || row.status !== "active") {
      req.session.destroy(() => {
        res.clearCookie("vjchat.sid");
        res.json({ user: null });
      });
      return;
    }
    const tr =
      row.teamRole === "supervisor" || row.teamRole === "agent"
        ? row.teamRole
        : "super_admin";
    if (req.session.teamRole !== tr) req.session.teamRole = tr;
    // Resolve the company label: an agent/supervisor inherits their
    // owner's company name (they don't have their own), super_admin uses
    // their own row. We do a second lookup only when needed so the
    // common case (super_admin) stays a single query.
    let companyName: string | null = row.companyName ?? null;
    if (!companyName && row.parentUserId) {
      const [owner] = await db
        .select({ companyName: usersTable.companyName })
        .from(usersTable)
        .where(eq(usersTable.id, row.parentUserId))
        .limit(1);
      companyName = owner?.companyName ?? null;
    }
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
      },
    });
  } catch (err) {
    req.log.error({ err }, "/auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/me — let the current user update their own profile fields.
// All fields are optional; only provided keys are written. `companyName` is
// only honored when the caller is a super_admin (team members inherit their
// owner's company name and shouldn't be able to set their own).
router.patch("/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<{
    name: string;
    companyName: string | null;
    mobilePhone: string | null;
  }> = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (name.length < 1 || name.length > 80) {
      res.status(400).json({ error: "Nama harus 1–80 karakter" });
      return;
    }
    patch.name = name;
  }
  if (body.mobilePhone !== undefined) {
    const raw = String(body.mobilePhone ?? "").trim();
    if (raw === "") {
      patch.mobilePhone = null;
    } else {
      if (raw.length < 6 || raw.length > 20 || !/^[+()\-\s\d]+$/.test(raw)) {
        res.status(400).json({ error: "Nomor HP tidak valid" });
        return;
      }
      patch.mobilePhone = raw;
    }
  }
  if (body.companyName !== undefined) {
    const [row] = await db
      .select({ parentUserId: usersTable.parentUserId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!row || row.parentUserId !== null) {
      res.status(403).json({ error: "Hanya super admin yang bisa mengubah nama perusahaan" });
      return;
    }
    const cn = String(body.companyName ?? "").trim();
    if (cn.length > 120) {
      res.status(400).json({ error: "Nama perusahaan terlalu panjang" });
      return;
    }
    patch.companyName = cn === "" ? null : cn;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Tidak ada perubahan" });
    return;
  }
  try {
    await db.update(usersTable).set(patch).where(eq(usersTable.id, userId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "PATCH /auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/me/photo — let the current user (any role, including super_admin)
// update their own avatar. Body: { profilePhotoUrl: string }. Empty string
// clears the photo. The URL must be one we serve ourselves (/api/media/...)
// or an absolute http(s) URL, matching the validation used for invited team
// members.
router.patch("/me/photo", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (typeof userId !== "number") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = req.body?.profilePhotoUrl;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "profilePhotoUrl harus string" });
    return;
  }
  const url = raw.trim();
  if (url.length > 500) {
    res.status(400).json({ error: "URL foto terlalu panjang" });
    return;
  }
  if (url !== "" && !url.startsWith("/api/media/") && !/^https?:\/\//.test(url)) {
    res.status(400).json({ error: "URL foto tidak valid" });
    return;
  }
  try {
    await db
      .update(usersTable)
      .set({ profilePhotoUrl: url || null })
      .where(eq(usersTable.id, userId));
    res.json({ profilePhotoUrl: url || null });
  } catch (err) {
    req.log.error({ err }, "PATCH /auth/me/photo failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signup", signupLimiter, async (req, res): Promise<void> => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const name = String(req.body?.name ?? "").trim();
    const companyName =
      typeof req.body?.companyName === "string"
        ? req.body.companyName.trim() || null
        : null;
    const mobilePhone =
      typeof req.body?.mobilePhone === "string"
        ? req.body.mobilePhone.trim() || null
        : null;

    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "Email tidak valid" });
      return;
    }
    if (!name || name.length > 120) {
      res.status(400).json({ error: "Nama wajib diisi (maks 120 karakter)" });
      return;
    }
    // Enforce the same length caps the OpenAPI contract advertises so
    // server behavior never diverges from the published spec.
    if (companyName !== null && companyName.length > 120) {
      res.status(400).json({ error: "Nama perusahaan maks 120 karakter" });
      return;
    }
    if (mobilePhone !== null && mobilePhone.length > 20) {
      res.status(400).json({ error: "Nomor HP maks 20 karakter" });
      return;
    }
    if (!isStrongPassword(password)) {
      res.status(400).json({
        error:
          "Password harus minimal 8 karakter dan mengandung huruf besar, angka, dan simbol",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        role: "user",
        // Status stays "pending" until the user clicks the verification
        // link. Approval-by-admin is no longer required — verifying the
        // email flips the account straight to "active".
        status: "pending",
        name,
        companyName,
        mobilePhone,
      })
      .onConflictDoNothing({ target: usersTable.email })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
      });
    if (inserted.length === 0) {
      res.status(409).json({ error: "Email sudah terdaftar" });
      return;
    }
    const row = inserted[0];
    const devVerifyUrl = await issueVerificationTokenAndSend(req, row);
    req.log.info(
      { userId: row.id, email: row.email, mailed: emailSenderConfigured() },
      "New signup created; verification email issued"
    );
    res.status(201).json({
      id: row.id,
      email: row.email,
      status: "pending",
      message:
        "Akun berhasil dibuat. Cek email Anda untuk link verifikasi (berlaku 24 jam).",
      devVerifyUrl: devVerifyUrl ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Signup failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post(
  "/verify-email",
  verifyEmailLimiter,
  async (req, res): Promise<void> => {
    try {
      const token = String(req.body?.token ?? "").trim();
      if (token.length < 16 || token.length > 200) {
        res.status(400).json({ error: "Token tidak valid" });
        return;
      }
      const tokenHash = sha256Hex(token);
      const [row] = await db
        .select()
        .from(emailVerificationTokensTable)
        .where(eq(emailVerificationTokensTable.tokenHash, tokenHash))
        .limit(1);
      if (!row) {
        res.status(400).json({ error: "Token tidak valid atau sudah dipakai" });
        return;
      }
      if (row.usedAt) {
        res.status(400).json({ error: "Token sudah dipakai" });
        return;
      }
      if (row.expiresAt.getTime() < Date.now()) {
        res.status(400).json({ error: "Token sudah kedaluwarsa. Minta link baru." });
        return;
      }
      // Activation must only flip pending + unverified accounts. An
      // account that was disabled (status="disabled") or re-revoked by
      // an admin AFTER signup must NOT be silently re-enabled by a
      // still-valid signup token — that would be a privilege bypass.
      // The WHERE clause encodes the only legal source state.
      const activated = await db
        .update(usersTable)
        .set({ status: "active", emailVerifiedAt: new Date() })
        .where(
          and(
            eq(usersTable.id, row.userId),
            eq(usersTable.status, "pending"),
            isNull(usersTable.emailVerifiedAt)
          )
        )
        .returning({ email: usersTable.email });
      // Always consume the token, even if the account is no longer in a
      // verifiable state — keeps the link single-use and makes replay
      // detection cleaner.
      await db
        .update(emailVerificationTokensTable)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokensTable.id, row.id));
      if (activated.length === 0) {
        const [user] = await db
          .select({
            email: usersTable.email,
            status: usersTable.status,
            emailVerifiedAt: usersTable.emailVerifiedAt,
          })
          .from(usersTable)
          .where(eq(usersTable.id, row.userId))
          .limit(1);
        // Already verified → treat as success so a repeated click from
        // the email client still lands on the happy page. Any other
        // state (disabled, deleted) → explicit refusal.
        if (user?.emailVerifiedAt) {
          res.json({ verified: true, email: user.email });
          return;
        }
        res.status(400).json({
          error: "Akun tidak dalam status yang dapat diverifikasi.",
        });
        return;
      }
      res.json({ verified: true, email: activated[0].email });
    } catch (err) {
      req.log.error({ err }, "Verify email failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.post(
  "/resend-verification",
  resendVerificationLimiter,
  async (req, res): Promise<void> => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!isLikelyEmail(email)) {
        // Always 200 to avoid leaking which emails exist in our DB.
        res.json({ ok: true, devVerifyUrl: null });
        return;
      }
      const [user] = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          name: usersTable.name,
          emailVerifiedAt: usersTable.emailVerifiedAt,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      // Same enumeration guard for already-verified / unknown emails:
      // pretend everything's fine and return 200 with no devVerifyUrl.
      if (!user || user.emailVerifiedAt || user.status !== "pending") {
        res.json({ ok: true, devVerifyUrl: null });
        return;
      }
      const devVerifyUrl = await issueVerificationTokenAndSend(req, user);
      res.json({ ok: true, devVerifyUrl: devVerifyUrl ?? null });
    } catch (err) {
      req.log.error({ err }, "Resend verification failed");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Unused imports keep the linter happy if we later need them.
void desc;
void gt;

export default router;
