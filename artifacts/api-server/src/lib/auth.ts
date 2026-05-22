import type { Request, Response, NextFunction } from "express";

// Augment the session payload with the fields we set on login.
declare module "express-session" {
  interface SessionData {
    userId?: number;
    userEmail?: string;
  }
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
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (getSessionUserId(req) == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}
