import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getSessionUserId } from "./auth";
import { isOwnerReadOnly } from "./billing";

// Read-only enforcement. An expired/suspended tenant can still log in and view
// everything (GET), but every state-changing request (POST/PUT/PATCH/DELETE) is
// rejected with 402 so the frontend can surface a "subscription inactive"
// banner. Mounted AFTER requireAuth, BEFORE the resource routers.
//
// Exemptions:
//  - non-write methods (GET/HEAD/OPTIONS) always pass — viewing is allowed.
//  - the platform operator (users.role === "admin") is never blocked.
//  - /admin/* (operator namespace, gated by requireAdmin) and /billing/*
//    (read-only views, no writes anyway) are skipped so an operator can always
//    manage tenants and any tenant can always see their own billing.
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT_PREFIXES = ["/admin", "/billing"];

export async function enforceSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (EXEMPT_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    next();
    return;
  }

  const userId = getSessionUserId(req);
  if (userId == null) {
    // requireAuth runs first, so this shouldn't happen — fail closed anyway.
    res.status(401).json({ error: "Not signed in" });
    return;
  }

  try {
    const [row] = await db
      .select({
        role: usersTable.role,
        parentUserId: usersTable.parentUserId,
        teamRole: usersTable.teamRole,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    // Platform operator is exempt entirely.
    if (row?.role === "admin") {
      next();
      return;
    }

    const ownerId =
      row && row.teamRole !== "super_admin" && row.parentUserId != null
        ? row.parentUserId
        : userId;

    if (await isOwnerReadOnly(ownerId)) {
      res.status(402).json({
        error:
          "Langganan Anda sudah tidak aktif. Akun dalam mode baca-saja — hubungi admin untuk mengaktifkan kembali.",
        code: "subscription_inactive",
      });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "enforceSubscription check failed");
    // Fail open on infra errors so a DB blip doesn't lock everyone out of
    // writes; requireAuth already guaranteed a valid session.
    next();
  }
}
