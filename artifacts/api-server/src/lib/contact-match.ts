// Pure, dependency-free phone-number normalization and contact name matching.
// Kept separate from `contacts.ts` (which imports the DB) so the matching logic
// can be unit-tested without a database connection.

// How many trailing digits we use as the prefix-insensitive match key. Local
// subscriber numbers in Indonesia (and most countries) are stable in their
// last ~9 digits regardless of whether the number is written as 08xx, 62 8xx
// or +62 8xx, so matching on the suffix bridges those formats.
export const MATCH_KEY_LEN = 9;

export interface NormalizedPhone {
  digits: string;
  matchKey: string;
}

// A stored Google Contacts row, reduced to the fields needed for matching.
export interface ContactMatchRow {
  phoneDigits: string;
  matchKey: string;
  name: string;
}

// Reduce a raw phone string (any format) to its bare digits plus a match key.
// Returns null when there aren't enough digits to be a real phone number.
export function normalizePhone(raw: string | null | undefined): NormalizedPhone | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  // Drop a single leading 0 (national trunk prefix) so 08xx aligns with 8xx.
  if (digits.length > 1 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  if (digits.length < 6) return null;
  const matchKey = digits.slice(-MATCH_KEY_LEN);
  return { digits, matchKey };
}

// Given saved contact rows and a list of phone digit strings (any format),
// return a map from the ORIGINAL input string to the saved Google Contact name,
// for whichever inputs we have a contact for. An exact full-number hit always
// wins; a suffix-only match is only used when it is unambiguous (a single
// distinct name shares that suffix) so we never guess across a collision.
export function matchContactNames(
  rows: ContactMatchRow[],
  phones: (string | null | undefined)[]
): Map<string, string> {
  const out = new Map<string, string>();
  // Normalize each input once, collecting both exact digits and suffix keys.
  const normByInput = new Map<string, NormalizedPhone>();
  for (const p of phones) {
    if (!p) continue;
    const norm = normalizePhone(p);
    if (!norm) continue;
    normByInput.set(p, norm);
  }
  if (normByInput.size === 0) return out;

  // Exact full-number index, plus a suffix index that records distinct names
  // per key so we can refuse an ambiguous suffix-only match.
  const nameByDigits = new Map<string, string>();
  const namesByKey = new Map<string, Set<string>>();
  for (const r of rows) {
    nameByDigits.set(r.phoneDigits, r.name);
    let set = namesByKey.get(r.matchKey);
    if (!set) {
      set = new Set<string>();
      namesByKey.set(r.matchKey, set);
    }
    set.add(r.name);
  }

  for (const [input, norm] of normByInput) {
    // Prefer an exact full-number hit; never guess across the suffix collision.
    const exact = nameByDigits.get(norm.digits);
    if (exact) {
      out.set(input, exact);
      continue;
    }
    const set = namesByKey.get(norm.matchKey);
    if (set && set.size === 1) {
      out.set(input, set.values().next().value!);
    }
  }
  return out;
}
