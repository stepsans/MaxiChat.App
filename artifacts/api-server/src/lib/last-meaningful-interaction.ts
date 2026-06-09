// ===========================================================================
// AI Sales Assistant — Last Meaningful Interaction (db-free, unit-tested).
//
// The Auto Follow-Up engine times every follow-up off the LAST MEANINGFUL
// interaction in a chat, not the raw last message. A customer replying "ok" or
// "👍" is an acknowledgement, not a substantive turn, so it must NOT reset the
// silence window (otherwise a polite "sip" would postpone every follow-up
// forever). This module picks the timestamp of the most recent non-filler
// message from a transcript. Pure functions → testable without the DB; the
// engine maps chat_messages rows into MeaningfulMessage and calls in.
// ===========================================================================

export type MeaningfulMessage = {
  // Message timestamp.
  at: Date;
  // Raw message text. Empty/whitespace counts as filler (e.g. a sticker-only
  // message has no text content).
  content: string;
};

// Indonesian + English acknowledgements that carry no new intent. Compared
// against the normalized (lowercased, punctuation-stripped) message text.
const FILLER_PHRASES = new Set<string>([
  "ok",
  "oke",
  "okay",
  "okey",
  "oke deh",
  "okedeh",
  "sip",
  "siap",
  "ya",
  "iya",
  "yaa",
  "yoi",
  "y",
  "yup",
  "yep",
  "baik",
  "noted",
  "nice",
  "good",
  "great",
  "mantap",
  "mantul",
  "makasih",
  "makasi",
  "thanks",
  "thank you",
  "thx",
  "ty",
  "terima kasih",
  "terimakasih",
  "trims",
  "ok thanks",
  "oke makasih",
  "oke thanks",
  "hmm",
  "hm",
  "wkwk",
  "wkwkwk",
  "haha",
  "hehe",
]);

// Strip everything except letters/digits/spaces (drops emoji, punctuation),
// collapse whitespace, lowercase. An emoji-only or punctuation-only message
// normalizes to "" → treated as filler.
function normalize(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A message is "filler" when it adds no substantive content: empty/whitespace,
// emoji/punctuation-only, a one-character token, or a known acknowledgement
// phrase. Everything else is meaningful.
export function isFillerMessage(content: string): boolean {
  const norm = normalize(content);
  if (norm.length === 0) return true;
  if (norm.length <= 1) return true;
  return FILLER_PHRASES.has(norm);
}

// The timestamp of the most recent MEANINGFUL message, or null when the
// transcript is empty or contains only filler. Order-independent: we scan all
// messages and keep the max `at` among non-filler ones.
export function lastMeaningfulInteractionAt(
  messages: ReadonlyArray<MeaningfulMessage>
): Date | null {
  let latest: Date | null = null;
  for (const m of messages) {
    if (isFillerMessage(m.content)) continue;
    if (latest === null || m.at.getTime() > latest.getTime()) {
      latest = m.at;
    }
  }
  return latest;
}
