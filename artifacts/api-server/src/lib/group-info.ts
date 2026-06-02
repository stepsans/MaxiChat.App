// DB-backed assembly of group participant display names. Kept out of the chats
// route (and out of the pure `group-participants` helper) so the wiring between
// the history-name SQL, the Google Contacts lookup, and the name-precedence
// helper can be integration-tested against a real database in isolation.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { resolveOwnerUserId } from "./seed";
import { resolveContactNames } from "./contacts";
import {
  participantRealDigits,
  resolveGroupParticipant,
  type BaileysParticipant,
  type ResolvedGroupParticipant,
} from "./group-participants";

// Minimal logger shape so callers can pass `req.log` without coupling this
// module to Express. The contacts lookup is best-effort: a failure there must
// not blank out names that were already resolvable from history/Baileys.
interface MiniLogger {
  warn: (obj: unknown, msg: string) => void;
}

// Resolve every group participant's display name + phone for a chat.
//
// `chatId` — the MaxiChat chat row whose stored inbound messages we mine for
// pushNames, keyed by the sender's digits (LID or real phone).
// `userId` — the requesting session user; resolved to the tenant owner so team
// members benefit from the owner's connected Google Contacts.
// `participantsRaw` — the participants from Baileys' groupMetadata.
export async function resolveGroupParticipants(
  chatId: number,
  userId: number,
  participantsRaw: BaileysParticipant[],
  log?: MiniLogger
): Promise<ResolvedGroupParticipant[]> {
  // Back-fill names from the pushNames stored on this group's inbound
  // messages, keyed by the sender's digits (which match jidDigits(participant
  // id)). DISTINCT ON keeps the most recent name per sender.
  const nameRes = await db.execute<{ digits: string; name: string }>(sql`
    SELECT DISTINCT ON (sender_phone_digits)
      sender_phone_digits AS digits, sender_name AS name
    FROM chat_messages
    WHERE chat_id = ${chatId}
      AND sender_phone_digits IS NOT NULL
      AND sender_name IS NOT NULL
      AND sender_name <> ''
    ORDER BY sender_phone_digits, created_at DESC
  `);
  const nameRows: { digits: string; name: string }[] =
    (nameRes as any).rows ?? (nameRes as any) ?? [];
  const nameByDigits = new Map<string, string>();
  for (const r of nameRows) {
    if (r.digits && r.name) nameByDigits.set(r.digits, r.name);
  }

  // Resolve saved Google Contacts names by real phone, scoped to the tenant
  // owner. Best-effort: never let a contacts failure drop the whole response.
  let contactNames = new Map<string, string>();
  try {
    const ownerUserId = await resolveOwnerUserId(userId);
    const phones = participantsRaw
      .map((pp) => participantRealDigits(pp))
      .filter((d): d is string => !!d);
    if (phones.length) {
      contactNames = await resolveContactNames(ownerUserId, phones);
    }
  } catch (err) {
    log?.warn({ err }, "group contacts name resolution failed");
  }

  return participantsRaw.map((pp) =>
    resolveGroupParticipant(pp, nameByDigits, contactNames)
  );
}
