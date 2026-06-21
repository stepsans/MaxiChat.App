// Db-free timezone helpers for AI Pipeline cut-off scheduling.
//
// Cut-off times are stored as wall-clock "HH:MM" strings in a pipeline's IANA
// timezone (default Asia/Jakarta). Scheduling and window computation must turn
// those wall-clock values into UTC instants — the server may run in any zone,
// so we never rely on Date#setHours (which uses the server's local time).

export interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// The calendar parts of `date` as seen in `timeZone`.
export function getTzParts(date: Date, timeZone: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = parseInt(p.value, 10);
  }
  // Some engines emit hour "24" at midnight — normalize to 0.
  let hour = map.hour ?? 0;
  if (hour === 24) hour = 0;
  return {
    year: map.year ?? 1970,
    month: map.month ?? 1,
    day: map.day ?? 1,
    hour,
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

// Offset (ms) of `timeZone` relative to UTC at the given instant.
// Positive means the zone is ahead of UTC (e.g. +7h for Asia/Jakarta).
function tzOffsetMs(date: Date, timeZone: string): number {
  const p = getTzParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

// Convert a wall-clock time in `timeZone` to the matching UTC instant.
// Month is 1-12. Out-of-range minute/hour (e.g. minute 60) is normalized via
// Date.UTC, so "previous cutoff + 1 minute" math works at boundaries.
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = tzOffsetMs(guess, timeZone);
  const adjusted = new Date(guess.getTime() - offset);
  // One refinement pass settles DST transitions. Asia/Jakarta has no DST so
  // this is a no-op there, but it keeps the helper correct for other zones.
  const offset2 = tzOffsetMs(adjusted, timeZone);
  if (offset2 !== offset) {
    return new Date(guess.getTime() - offset2);
  }
  return adjusted;
}
