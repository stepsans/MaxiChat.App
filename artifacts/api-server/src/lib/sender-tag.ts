import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// WhatsApp italic syntax uses underscores. We append on its own line so
// the tag is visually separated from the message body. Empty/whitespace-
// only inputs return the tag as a standalone message (used as a caption
// fallback when an agent attaches media with no caption).
export function withTag(text: string | null | undefined, tag: string): string {
  const body = (text ?? "").trimEnd();
  const sig = `_${tag}_`;
  if (!body) return sig;
  return `${body}\n\n${sig}`;
}

export const CHATBOT_TAG = "Chatbot";
export const AI_TAG = "powered by AI";

// Strip a trailing `\n\n_<anything>_` signature from a stored outbound
// message before feeding it back to the LLM as conversation history.
// Without this, the model sees its own past `_powered by AI_` (and the
// agent/chatbot tags) and is tempted to either roleplay as that agent
// or to emit a signature itself — which `withTag` would then double up.
export function stripTrailingTag(text: string): string {
  return text.replace(/\n*_[^_\n]+_\s*$/u, "").trimEnd();
}

// Resolve the display name to use for a human agent's signature. Prefers
// the `name` column; falls back to the email's local part so we always
// emit *something* readable. Cached per request via a per-userId Map is
// not worth it — Postgres lookups by primary key are sub-ms and the
// callers (manual reply, media send, product send) are user-initiated.
export async function resolveAgentTag(userId: number): Promise<string> {
  const [row] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!row) return "Agen";
  if (row.name && row.name.trim()) {
    // First word only — keeps the signature compact ("Stephen", not
    // "Stephen Wijaya Putra"). The full name is still visible in the
    // dashboard's message author column.
    return row.name.trim().split(/\s+/)[0]!;
  }
  return row.email.split("@")[0] || "Agen";
}
