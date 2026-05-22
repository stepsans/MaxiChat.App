import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const router = Router();

router.post("/login", async (req, res): Promise<void> => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
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
    // Regenerate the session id on login to prevent session fixation.
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );
    res.json({ id: user.id, email: user.email });
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

router.get("/me", (req, res): void => {
  const userId = req.session?.userId;
  const email = req.session?.userEmail;
  if (typeof userId === "number" && typeof email === "string") {
    res.json({ user: { id: userId, email } });
    return;
  }
  res.json({ user: null });
});

export default router;
