import crypto from "crypto";
import { db } from "@workspace/db";
import { emailVerificationTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Email verification links for self-signup. Mirrors the agent-invitation
// pattern: we store only a SHA-256 hash of the token so a DB leak never
// exposes a live link. The link activates the account (status pending →
// active) and, for owners, commits the trial — see the /auth/verify-email
// route. A click never creates a session; the user logs in afterwards via
// email OTP.
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam

// Issue a fresh verification token for a user. Older rows stay in the table
// but become irrelevant — verify always looks the token up by its own hash.
export async function createEmailVerification(
  userId: number
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.insert(emailVerificationTokensTable).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export type ConsumeVerificationResult =
  | { ok: true; userId: number; alreadyUsed: boolean }
  | { ok: false; error: string };

// Consume a verification token (single-use). A second click on an
// already-used token resolves idempotently (ok:true, alreadyUsed:true) so a
// re-click reads as success rather than a scary error — the route then
// treats activation as a no-op.
export async function consumeEmailVerification(
  token: string
): Promise<ConsumeVerificationResult> {
  const [row] = await db
    .select()
    .from(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return { ok: false, error: "Link verifikasi tidak valid." };
  if (row.usedAt) return { ok: true, userId: row.userId, alreadyUsed: true };
  if (row.expiresAt < new Date()) {
    return { ok: false, error: "Link verifikasi kadaluarsa (24 jam). Minta link baru." };
  }

  await db
    .update(emailVerificationTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokensTable.id, row.id));
  return { ok: true, userId: row.userId, alreadyUsed: false };
}
