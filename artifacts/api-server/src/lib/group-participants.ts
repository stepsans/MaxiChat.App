// Pure, dependency-free helpers for resolving group participant display names.
// Kept separate from the chats route so the name-precedence logic can be unit
// tested without spinning up Express or the DB.

// Baileys participants extend Contact, so each may carry the real phone
// (`phoneNumber`, a @s.whatsapp.net jid) alongside a synthetic LID `id`.
export type BaileysParticipant = {
  id: string;
  admin?: string | null;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
};

export interface ResolvedGroupParticipant {
  jid: string;
  phone: string | null;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

// Extract the bare numeric local-part of a jid (dropping any device suffix and
// @domain), or null when it isn't a plain phone/LID number.
export function jidDigits(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const local = jid.split("@")[0].split(":")[0];
  return /^[0-9]+$/.test(local) ? local : null;
}

// The synthetic LID digits for a participant (the long number that matches
// nothing in the user's address book), preferring the id then the lid field.
export function participantLidDigits(pp: BaileysParticipant): string | null {
  return jidDigits(pp.id) ?? jidDigits(pp.lid ?? "");
}

// The participant's real phone digits when known: an explicit phoneNumber
// field, or the id itself when it's already a PN jid rather than a @lid.
export function participantRealDigits(pp: BaileysParticipant): string | null {
  return (
    jidDigits(pp.phoneNumber ?? "") ??
    (pp.id.endsWith("@s.whatsapp.net") ? jidDigits(pp.id) : null)
  );
}

// Resolve a single participant's display fields.
//
// `nameByDigits` maps a phone/LID digit string to the best push/contact name
// seen on this group's message history. `contactNames` maps a real-phone digit
// string to the saved Google Contacts name.
//
// Name precedence (most→least trustworthy):
//   1. Baileys contact name (`name`)
//   2. Baileys push name (`notify`)
//   3. real-phone history name
//   4. saved Google Contacts name on the real phone
//   5. LID-derived history name (weakest — a synthetic identity)
export function resolveGroupParticipant(
  pp: BaileysParticipant,
  nameByDigits: Map<string, string>,
  contactNames: Map<string, string>
): ResolvedGroupParticipant {
  const lidDigits = participantLidDigits(pp);
  const realDigits = participantRealDigits(pp);
  // Keep real-phone and LID-derived history names separate: a name stored
  // against the real phone is a trustworthy identity, while a LID-derived one
  // is the weakest signal and must never override a real-phone match.
  const realHistoryName = realDigits ? nameByDigits.get(realDigits) ?? null : null;
  const lidHistoryName = lidDigits ? nameByDigits.get(lidDigits) ?? null : null;
  const name =
    pp.name ??
    pp.notify ??
    realHistoryName ??
    (realDigits ? contactNames.get(realDigits) ?? null : null) ??
    lidHistoryName;
  return {
    jid: pp.id,
    // Show the real phone when we have it; otherwise fall back to the LID
    // digits so the row still renders something stable.
    phone: realDigits ?? lidDigits,
    name,
    isAdmin: pp.admin === "admin" || pp.admin === "superadmin",
    isSuperAdmin: pp.admin === "superadmin",
  };
}
