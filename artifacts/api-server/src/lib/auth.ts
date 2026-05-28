import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// Augment the session payload with the fields we set on login.
declare module "express-session" {
  interface SessionData {
    userId?: number;
    userEmail?: string;
    userRole?: "user" | "admin";
    teamRole?: "super_admin" | "supervisor" | "agent";
  }
}

export type TeamRole = "super_admin" | "supervisor" | "agent";

// Resolve the user's owning account: super_admin → themselves; supervisor /
// agent → their parent (the WhatsApp account owner). This is the user id all
// ownerPhone / scoping logic should pivot on so an invited agent sees the
// same WhatsApp data as the super_admin who invited them.
export async function getEffectiveOwnerUserId(
  userId: number
): Promise<number> {
  const [row] = await db
    .select({
      parentUserId: usersTable.parentUserId,
      teamRole: usersTable.teamRole,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!row) return userId;
  if (row.teamRole === "super_admin" || row.parentUserId == null) return userId;
  return row.parentUserId;
}

// Resolve the signed-in user's id from the session, or null. Throws nothing —
// callers decide whether absence is an error (most API routes return 401, but
// /auth/me returns { user: null }).
export function getSessionUserId(req: Request): number | null {
  const id = req.session?.userId;
  return typeof id === "number" ? id : null;
}

// Express middleware that gates every request behind a valid session. Mounted
// on `/api` *after* the public auth routes are registered.
//
// We also re-verify that the session's userId still maps to an active row,
// so a session cookie for a deleted/disabled user can't keep accessing the
// API after self-delete / admin disable. The DB hit is one indexed lookup
// per request, acceptable for our scale. On mismatch we destroy the
// session and clear the cookie before returning 401.
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = getSessionUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  try {
    const [row] = await db
      .select({ id: usersTable.id, status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!row || row.status !== "active") {
      req.session.destroy(() => {
        res.clearCookie("vjchat.sid");
        res.status(401).json({ error: "Session expired" });
      });
      return;
    }
  } catch (err) {
    // Don't leak the user error path on DB blips — log and 500 so the
    // client can retry rather than getting silently logged out.
    (req as Request & { log?: { error: (o: unknown, m?: string) => void } }).log?.error(
      { err },
      "requireAuth DB lookup failed"
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  next();
}

// Admin gate. Cached role on the session is the fast path; we still
// re-check the DB as a defense in case role was revoked mid-session. Mount
// after requireAuth.
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = getSessionUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  try {
    const [row] = await db
      .select({ role: usersTable.role, status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!row || row.status !== "active" || row.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    // Keep the session's cached role in sync with the DB.
    req.session.userRole = "admin";
    next();
  } catch (err) {
    req.log.error({ err }, "requireAdmin DB check failed");
    res.status(500).json({ error: "Internal server error" });
  }
}
