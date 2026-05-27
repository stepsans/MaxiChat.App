import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getSessionUserId } from "./auth";

export type TeamRole = "super_admin" | "supervisor" | "agent";

// Always resolve teamRole from the DB instead of trusting req.session, so a
// role demotion takes effect immediately on the next request rather than at
// the next /auth/me poll. The session cache is still synced opportunistically
// in /auth/me but middleware that *gates* sensitive actions must not depend
// on it.
export async function getCurrentTeamRole(userId: number): Promise<TeamRole> {
  const [row] = await db
    .select({ teamRole: usersTable.teamRole })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const tr = row?.teamRole;
  return tr === "supervisor" || tr === "agent" ? tr : "super_admin";
}

function gate(
  allowed: ReadonlyArray<TeamRole>,
  errMsg: string
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uid = getSessionUserId(req);
    if (uid == null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    try {
      const role = await getCurrentTeamRole(uid);
      if (!allowed.includes(role)) {
        res.status(403).json({ error: errMsg });
        return;
      }
      next();
    } catch (err) {
      req.log.error({ err }, "team-permission check failed");
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

// Knowledge Base / Products / Chatbot Flow CRUD: agent is read-only.
export const requireSupervisorOrAbove = gate(
  ["super_admin", "supervisor"],
  "Hanya Supervisor atau Super Admin yang dapat melakukan aksi ini"
);

// Status menu: anyone can add, only supervisor+ can delete.
export const requireNotAgent = gate(
  ["super_admin", "supervisor"],
  "Agen tidak diizinkan melakukan aksi ini"
);

// super_admin-only (team settings, plan changes).
export const requireSuperAdmin = gate(
  ["super_admin"],
  "Hanya Super Admin yang dapat melakukan aksi ini"
);
