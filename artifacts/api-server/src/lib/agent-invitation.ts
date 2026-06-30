import crypto from "crypto";
import { db } from "@workspace/db";
import { agentInvitationsTable, usersTable, platformSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export async function getAppUrl(): Promise<string> {
  const [row] = await db.select().from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, "app_url")).limit(1);
  return row?.value?.trim() || process.env.PUBLIC_URL?.trim() || "https://maxichat.app";
}

export async function createAgentInvitation(agentUserId: number, invitedByUserId: number, agentEmail: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.insert(agentInvitationsTable).values({
    email: agentEmail.toLowerCase().trim(), tokenHash: hashToken(token),
    invitedByUserId, agentUserId, expiresAt,
  });
  return { token, expiresAt };
}

export async function verifyAgentInvitation(token: string) {
  const [inv] = await db.select().from(agentInvitationsTable)
    .where(eq(agentInvitationsTable.tokenHash, hashToken(token))).limit(1);
  if (!inv) return { ok: false, error: "Link undangan tidak valid." };
  if (inv.acceptedAt) return { ok: false, error: "Link sudah pernah digunakan." };
  if (inv.expiresAt < new Date()) return { ok: false, error: "Link sudah kadaluarsa (24 jam). Minta Super Admin kirim ulang." };

  await db.transaction(async (tx) => {
    await tx.update(agentInvitationsTable).set({ acceptedAt: new Date() }).where(eq(agentInvitationsTable.id, inv.id));
    await tx.update(usersTable).set({ emailVerifiedAt: new Date(), status: "active" }).where(eq(usersTable.id, inv.agentUserId));
  });
  return { ok: true, agentUserId: inv.agentUserId, email: inv.email };
}
