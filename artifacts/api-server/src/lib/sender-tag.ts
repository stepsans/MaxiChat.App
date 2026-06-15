import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// The pure (db-free) signature helpers live in sender-tag-pure.ts so db-free
// modules can use them. Re-exported here so existing importers of
// "../lib/sender-tag.js" keep working unchanged.
export {
  withTag,
  stripTrailingTag,
  hasAutomatedSignature,
  CHATBOT_TAG,
  AI_TAG,
  FOLLOW_UP_TAG,
} from "./sender-tag-pure.js";

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
