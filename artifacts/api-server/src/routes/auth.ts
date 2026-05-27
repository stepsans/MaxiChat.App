import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const router = Router();

// Normalize + minimally validate an email for storage / lookup.
function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}
function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
}

router.post("/login", async (req, res): Promise<void> => {
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
    // Block non-active accounts (pending approval or disabled). We use 403
    // with a distinct message so the UI can surface the actual reason
    // instead of the generic "wrong password" string.
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
    // Regenerate the session id on login to prevent session fixation.
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
  // Re-read role/status from the DB so a logged-in user who gets disabled
  // or demoted reflects it on the next /me poll (the AuthGate polls every
  // 60s). If the row vanished, the session is stale — clear it.
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
    // Keep session.teamRole in sync with the DB so a role change (e.g.
    // supervisor → agent) takes effect on the next /me poll.
    const tr =
      row.teamRole === "supervisor" || row.teamRole === "agent"
        ? row.teamRole
        : "super_admin";
    if (req.session.teamRole !== tr) req.session.teamRole = tr;
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
      },
    });
  } catch (err) {
    req.log.error({ err }, "/auth/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signup", async (req, res): Promise<void> => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!isLikelyEmail(email)) {
      res.status(400).json({ error: "Email tidak valid" });
      return;
    }
    if (password.length < 8 || password.length > 200) {
      res.status(400).json({ error: "Password minimal 8 karakter" });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    // Use an atomic insert with ON CONFLICT DO NOTHING so concurrent
    // signups for the same email collapse to a single 409 instead of one
    // succeeding and the other crashing with a unique-violation 500.
    const inserted = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        role: "user",
        status: "pending",
      })
      .onConflictDoNothing({ target: usersTable.email })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        status: usersTable.status,
      });
    if (inserted.length === 0) {
      res.status(409).json({ error: "Email sudah terdaftar" });
      return;
    }
    const row = inserted[0];
    req.log.info(
      { userId: row.id, email: row.email },
      "New signup pending approval"
    );
    res.status(201).json({
      id: row.id,
      email: row.email,
      status: "pending",
      message:
        "Akun berhasil dibuat. Menunggu persetujuan admin sebelum dapat login.",
    });
  } catch (err) {
    req.log.error({ err }, "Signup failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
