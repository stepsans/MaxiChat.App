import type { DashboardRange } from "@/hooks/useDashboard";

export type RangePreset = "today" | "7d" | "month" | "custom";

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: "Hari ini",
  "7d": "7 hari",
  month: "Bulan ini",
  custom: "Kustom",
};

// Build an ISO range for a preset. "today" = local midnight → now (live).
export function rangeForPreset(preset: RangePreset, now = new Date()): DashboardRange {
  const end = now;
  let start: Date;
  switch (preset) {
    case "7d":
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "today":
    default:
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

// Only "today" is live (worth polling); the rest are report snapshots.
export function isLivePreset(preset: RangePreset): boolean {
  return preset === "today";
}
