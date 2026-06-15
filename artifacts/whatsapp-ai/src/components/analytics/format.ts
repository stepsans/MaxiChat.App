// Shared formatting + types for the Laporan & Jadwal (analytics) surface.

export type PeriodKey = "today" | "7d" | "30d" | "custom";

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: "Hari ini",
  "7d": "7 hari",
  "30d": "30 hari",
  custom: "Custom",
};

/** Whole-Rupiah, dot thousands separator: 1800000 -> "Rp 1.800.000". */
export function formatRupiah(n: number): string {
  return "Rp " + Math.round(n).toLocaleString("id-ID");
}

/** Seconds -> short human duration in WIB-agnostic terms. */
export function formatDurationSeconds(sec: number): string {
  if (sec <= 0) return "0 dtk";
  if (sec < 60) return `${Math.round(sec)} dtk`;
  const min = sec / 60;
  if (min < 60) return `${min % 1 === 0 ? min : min.toFixed(1)} mnt`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} j ${m} mnt` : `${h} jam`;
}

export function formatMinutes(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${min} mnt`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}j ${m}m` : `${h} jam`;
}

const ID_DATETIME = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});

/** ISO -> "10 Jun 2026, 14:30" (WIB). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return ID_DATETIME.format(new Date(iso)).replace(/\./g, ":").replace(":,", ",");
  } catch {
    return "—";
  }
}

// ISO weekday: 1=Mon .. 7=Sun (matches report-schedule-build's recurrenceDays).
export const ISO_WEEKDAYS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: "Sen" },
  { iso: 2, label: "Sel" },
  { iso: 3, label: "Rab" },
  { iso: 4, label: "Kam" },
  { iso: 5, label: "Jum" },
  { iso: 6, label: "Sab" },
  { iso: 7, label: "Min" },
];

const ISO_LABEL: Record<number, string> = Object.fromEntries(ISO_WEEKDAYS.map((d) => [d.iso, d.label]));

/** ISO weekday numbers (1=Mon..7=Sun) -> "Sen, Sel, Rab" summary. */
export function formatRecurrenceDays(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return "—";
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map((d) => ISO_LABEL[d] ?? `?${d}`).join(", ");
}

export function frequencyLabel(freq: string): string {
  switch (freq) {
    case "once":
      return "Sekali kirim";
    case "daily":
      return "Harian";
    case "weekly":
      return "Mingguan";
    case "monthly":
      return "Bulanan";
    default:
      return freq;
  }
}

/** Human label for the content-type chips/cards. */
export const CONTENT_TYPE_LABEL: Record<string, string> = {
  kpi: "Ringkasan KPI",
  ai_analysis: "Analisa AI",
  chat_history: "Riwayat Chat",
  trend: "Tren",
};
