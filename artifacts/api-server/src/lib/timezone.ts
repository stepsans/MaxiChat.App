// WIB (Asia/Jakarta, UTC+7, no DST) helpers. Every Dashboard cutoff and "today"
// boundary anchors here so day rollover happens at 00:00 WIB regardless of the
// server's own timezone (usually UTC). Offset is fixed (+7h) — Indonesia has not
// observed DST since 1964 — so a plain millisecond shift is correct & cheap.

export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// UTC instant of 00:00:00 WIB for the WIB calendar day that contains `now`.
export function startOfWibDay(now: Date = new Date()): Date {
  const shifted = now.getTime() + WIB_OFFSET_MS; // move into "WIB clock" space
  const dayMs = 24 * 60 * 60 * 1000;
  const wibMidnightInShifted = Math.floor(shifted / dayMs) * dayMs;
  return new Date(wibMidnightInShifted - WIB_OFFSET_MS);
}

// The daily snapshot cutoffs (09/12/15/18/21 WIB) as UTC instants for the WIB
// day containing `now`.
export const WIB_CUTOFF_HOURS = [9, 12, 15, 18, 21] as const;

export function wibCutoffsForDay(now: Date = new Date()): Date[] {
  const base = startOfWibDay(now).getTime();
  return WIB_CUTOFF_HOURS.map((h) => new Date(base + h * 60 * 60 * 1000));
}

// "HH:MM" in WIB, for the "diperbarui HH:MM WIB" label.
export function wibTimeLabel(d: Date): string {
  const shifted = new Date(d.getTime() + WIB_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
