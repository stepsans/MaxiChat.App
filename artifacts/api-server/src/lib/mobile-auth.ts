import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, authTokensTable, usersTable } from "@workspace/db";

// 90-day token lifetime. Long-lived so the mobile user stays signed in; we
// avoid refreshing on every request to keep auth resolution a single cheap
// indexed lookup.
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MobileTokenUser {
  userId: number;
  email: string;
  role: "user" | "admin";
  teamRole: "super_admin" | "supervisor" | "agent";
}

// Issue a new opaque bearer token for `userId`. Returns the raw token (shown
// to the client exactly once); only its hash is persisted.
export async function createMobileToken(
  userId: number,
  label?: string | null,
): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.insert(authTokensTable).values({
    userId,
    tokenHash,
    label: label ?? null,
    expiresAt,
  });
  return raw;
}

// Resolve a raw bearer token to its (active) user, or null. Validates the
// token isn't expired and the user is still active. Used by the bearer-auth
// middleware to populate a synthetic session.
export async function resolveMobileToken(
  raw: string,
): Promise<MobileTokenUser | null> {
  if (!raw || raw.length < 16 || raw.length > 200) return null;
  const tokenHash = hashToken(raw);
  const now = new Date();
  const [row] = await db
    .select({
      userId: usersTable.id,
      email: usersTable.email,
      role: usersTable.role,
      teamRole: usersTable.teamRole,
      status: usersTable.status,
    })
    .from(authTokensTable)
    .innerJoin(usersTable, eq(usersTable.id, authTokensTable.userId))
    .where(
      and(
        eq(authTokensTable.tokenHash, tokenHash),
        or(isNull(authTokensTable.expiresAt), gt(authTokensTable.expiresAt, now)),
      ),
    )
    .limit(1);
  if (!row || row.status !== "active") return null;
  return {
    userId: row.userId,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    teamRole:
      row.teamRole === "supervisor" || row.teamRole === "agent"
        ? row.teamRole
        : "super_admin",
  };
}

// Best-effort: bump last_used_at so we can surface "last active" without
// blocking the request. Fire-and-forget from the middleware.
export function touchMobileToken(raw: string): void {
  const tokenHash = hashToken(raw);
  void db
    .update(authTokensTable)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(authTokensTable.tokenHash, tokenHash))
    .catch(() => {});
}

// Revoke (delete) a token on logout. Idempotent.
export async function revokeMobileToken(raw: string): Promise<void> {
  const tokenHash = hashToken(raw);
  await db.delete(authTokensTable).where(eq(authTokensTable.tokenHash, tokenHash));
}
