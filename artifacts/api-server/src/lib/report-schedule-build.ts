// Pure (db-free) helpers for report scheduling — unit-testable in isolation.
// All cadence math is done in the schedule's timezone. The codebase is
// WIB-centric; we map known offsets and default to WIB (+7) otherwise.

export type ReportFrequency = "once" | "daily" | "weekly" | "monthly";

export interface ScheduleTiming {
  frequency: ReportFrequency;
  sendTime: string; // "HH:mm"
  recurrenceDays?: number[] | null; // weekly: ISO 1..7 (1=Mon)
  timezone?: string;
}

const TZ_OFFSET_MIN: Record<string, number> = {
  "Asia/Jakarta": 7 * 60,
  "Asia/Makassar": 8 * 60,
  "Asia/Jayapura": 9 * 60,
  UTC: 0,
};

function offsetMs(timezone?: string): number {
  const min = timezone && timezone in TZ_OFFSET_MIN ? TZ_OFFSET_MIN[timezone] : 7 * 60;
  return min * 60_000;
}

function parseHm(sendTime: string): [number, number] {
  const [h, m] = sendTime.split(":").map((n) => Number(n));
  return [Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 0];
}

/** ISO weekday 1..7 (1=Monday) for a UTC-wallclock date. */
function isoDow(d: Date): number {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/**
 * Next fire time (UTC) strictly after `now`, or null for a one-time schedule
 * (which is sent immediately on creation, not scheduled forward).
 */
export function calculateNextScheduledAt(t: ScheduleTiming, now: Date = new Date()): Date | null {
  if (t.frequency === "once") return null;

  const off = offsetMs(t.timezone);
  const [hh, mm] = parseHm(t.sendTime);
  // "wall clock" = UTC fields shifted into the tenant's local time.
  const wall = new Date(now.getTime() + off);

  const buildUtc = (y: number, mo: number, d: number): Date =>
    new Date(Date.UTC(y, mo, d, hh, mm, 0) - off);

  if (t.frequency === "daily") {
    let cand = buildUtc(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
    if (cand.getTime() <= now.getTime()) cand = buildUtc(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
    return cand;
  }

  if (t.frequency === "weekly") {
    const days = (t.recurrenceDays && t.recurrenceDays.length ? t.recurrenceDays : [1]).slice().sort((a, b) => a - b);
    for (let i = 0; i < 8; i++) {
      const dayWall = new Date(wall.getTime() + i * 86_400_000);
      if (days.includes(isoDow(dayWall))) {
        const cand = buildUtc(dayWall.getUTCFullYear(), dayWall.getUTCMonth(), dayWall.getUTCDate());
        if (cand.getTime() > now.getTime()) return cand;
      }
    }
    // Fallback: a week out at the first selected day.
    const next = new Date(wall.getTime() + 7 * 86_400_000);
    return buildUtc(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
  }

  // monthly — 1st of the month at sendTime.
  let cand = buildUtc(wall.getUTCFullYear(), wall.getUTCMonth(), 1);
  if (cand.getTime() <= now.getTime()) cand = buildUtc(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1);
  return cand;
}

export const VALID_CONTENT_TYPES = ["kpi", "ai_analysis", "chat_history", "trend"] as const;
export const VALID_FREQUENCIES: ReportFrequency[] = ["once", "daily", "weekly", "monthly"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ScheduleValidationError {
  field: string;
  message: string;
}

export function validateScheduleInput(input: {
  name?: string;
  contentTypes?: string[];
  frequency?: string;
  recurrenceDays?: number[] | null;
  sendTime?: string;
  recipientEmails?: string[];
}): ScheduleValidationError | null {
  if (!input.name || !input.name.trim()) return { field: "name", message: "Nama jadwal wajib diisi" };
  if (input.name.length > 100) return { field: "name", message: "Nama maksimal 100 karakter" };
  if (!input.contentTypes?.length) return { field: "contentTypes", message: "Pilih minimal 1 isi laporan" };
  for (const c of input.contentTypes) {
    if (!VALID_CONTENT_TYPES.includes(c as (typeof VALID_CONTENT_TYPES)[number])) {
      return { field: "contentTypes", message: `Isi laporan tidak valid: ${c}` };
    }
  }
  if (!input.frequency || !VALID_FREQUENCIES.includes(input.frequency as ReportFrequency)) {
    return { field: "frequency", message: "Frekuensi tidak valid" };
  }
  if (input.frequency === "weekly" && !input.recurrenceDays?.length) {
    return { field: "recurrenceDays", message: "Pilih minimal 1 hari untuk frekuensi mingguan" };
  }
  if (input.sendTime && !/^\d{2}:\d{2}$/.test(input.sendTime)) {
    return { field: "sendTime", message: "Format jam harus HH:mm" };
  }
  if (!input.recipientEmails?.length) return { field: "recipientEmails", message: "Tambahkan minimal 1 email tujuan" };
  for (const e of input.recipientEmails) {
    if (!EMAIL_RE.test(e)) return { field: "recipientEmails", message: `Email tidak valid: ${e}` };
  }
  return null;
}
