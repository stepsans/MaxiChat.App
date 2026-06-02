import { google } from "googleapis";
import { and, eq, inArray, or } from "drizzle-orm";
import { db, googleContactsTable } from "@workspace/db";
import { resolveOwnerUserId } from "./seed";
import {
  MATCH_KEY_LEN,
  matchContactNames,
  normalizePhone,
  type NormalizedPhone,
} from "./contact-match";

export { normalizePhone, type NormalizedPhone };

// Pull the user's Google Contacts via the People API and replace the stored
// snapshot for that user. Returns the number of phone-bearing contact rows
// written. `auth` must be an authorized OAuth2 client with the
// contacts.readonly scope.
export async function syncGoogleContacts(
  userId: number,
  auth: InstanceType<typeof google.auth.OAuth2>
): Promise<number> {
  // Contacts are stored per tenant owner so team members share the owner's
  // address book; resolve up-front and key every row on the owner id.
  const ownerUserId = await resolveOwnerUserId(userId);
  const people = google.people({ version: "v1", auth });
  // Dedupe per FULL phone digits (not by suffix match key) so two distinct
  // numbers that happen to share the same trailing digits are both kept; last
  // write wins for the exact same number.
  const byDigits = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const resp = await people.people.connections.list({
      resourceName: "people/me",
      personFields: "names,phoneNumbers",
      pageSize: 1000,
      pageToken,
      sortOrder: "LAST_MODIFIED_DESCENDING",
    });
    for (const person of resp.data.connections ?? []) {
      const name =
        person.names?.find((n) => n.displayName)?.displayName?.trim() || "";
      if (!name) continue;
      for (const ph of person.phoneNumbers ?? []) {
        const norm = normalizePhone(ph.canonicalForm ?? ph.value);
        if (!norm) continue;
        byDigits.set(norm.digits, name);
      }
    }
    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  const rows = Array.from(byDigits.entries()).map(([digits, name]) => ({
    userId: ownerUserId,
    name,
    phoneDigits: digits,
    matchKey: digits.slice(-MATCH_KEY_LEN),
    updatedAt: new Date(),
  }));

  // Replace the snapshot atomically: clear the owner's old rows, then bulk
  // insert the fresh set. Chunk inserts to stay under parameter limits.
  await db.transaction(async (tx) => {
    await tx
      .delete(googleContactsTable)
      .where(eq(googleContactsTable.userId, ownerUserId));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      if (chunk.length) await tx.insert(googleContactsTable).values(chunk);
    }
  });
  return rows.length;
}

// Given a list of phone digit strings (any format), return a map from the
// ORIGINAL input string to the saved Google Contact name, for whichever
// inputs we have a contact for. Matching is prefix-insensitive (by suffix).
export async function resolveContactNames(
  userId: number,
  phones: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ownerUserId = await resolveOwnerUserId(userId);
  // Normalize each input once to collect the exact digits and suffix keys we
  // need to fetch candidate rows for.
  const exactDigits = new Set<string>();
  const matchKeys = new Set<string>();
  for (const p of phones) {
    const norm = normalizePhone(p);
    if (!norm) continue;
    exactDigits.add(norm.digits);
    matchKeys.add(norm.matchKey);
  }
  if (matchKeys.size === 0) return new Map<string, string>();

  const rows = await db
    .select({
      phoneDigits: googleContactsTable.phoneDigits,
      matchKey: googleContactsTable.matchKey,
      name: googleContactsTable.name,
    })
    .from(googleContactsTable)
    .where(
      and(
        eq(googleContactsTable.userId, ownerUserId),
        or(
          inArray(googleContactsTable.phoneDigits, Array.from(exactDigits)),
          inArray(googleContactsTable.matchKey, Array.from(matchKeys))
        )
      )
    );

  // The matching rules (exact wins, ambiguous suffix refuses to guess) live in
  // a pure, DB-free helper so they can be unit tested in isolation.
  return matchContactNames(rows, phones);
}

// Count how many contacts are stored for the user's tenant (for the UI status).
export async function countGoogleContacts(userId: number): Promise<number> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const rows = await db
    .select({ id: googleContactsTable.id })
    .from(googleContactsTable)
    .where(eq(googleContactsTable.userId, ownerUserId));
  return rows.length;
}
