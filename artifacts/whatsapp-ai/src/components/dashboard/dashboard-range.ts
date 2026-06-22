import type { DashboardRange } from "@/hooks/useDashboard";

export type RangePreset = "today" | "7d" | "month" | "custom";

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: "Hari ini",
  "7d": "7 hari",
  month: "Bulan ini",
  custom: "Kustom",
};

// WIB (Asia/Jakarta, UTC+7, no DST). Day boundaries anchor here so "Hari ini"
// matches the backend snapshot cutoffs regardless of the viewer's local TZ.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// UTC instant of 00:00 WIB for the WIB day containing `now`.
function startOfWibDay(now: Date): Date {
  const shifted = now.getTime() + WIB_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - WIB_OFFSET_MS);
}

// UTC instant of 00:00 WIB on the first day of the WIB month containing `now`.
function startOfWibMonth(now: Date): Date {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const firstUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return new Date(firstUtc - WIB_OFFSET_MS);
}

// Build an ISO range for a preset. "today" = WIB midnight → now (live).
export function rangeForPreset(preset: RangePreset, now = new Date()): DashboardRange {
  const end = now;
  let start: Date;
  switch (preset) {
    case "7d":
      start = new Date(startOfWibDay(now).getTime() - 6 * DAY_MS);
      break;
    case "month":
      start = startOfWibMonth(now);
      break;
    case "today":
    default:
      start = startOfWibDay(now);
      break;
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

// Only "today" is live (worth polling); the rest are report snapshots.
export function isLivePreset(preset: RangePreset): boolean {
  return preset === "today";
}
