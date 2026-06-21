// Shared presentation helpers for the token-quota UI (Pemakaian Token page +
// global quota bell). Keep the notifyLevel → colour/label mapping in one place
// so the bar, badge, and bell never disagree.

export type NotifyLevel = "ok" | "warn80" | "warn20" | "crit5" | "depleted";

export interface QuotaTone {
  // Tailwind classes for a filled bar / dot of this severity.
  bar: string;
  dot: string;
  text: string;
  label: string;
}

const TONES: Record<NotifyLevel, QuotaTone> = {
  ok: { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-600", label: "Aman" },
  warn80: { bar: "bg-amber-500", dot: "bg-amber-500", text: "text-amber-600", label: "Perhatian (80%)" },
  warn20: { bar: "bg-amber-500", dot: "bg-amber-500", text: "text-amber-600", label: "Menipis" },
  crit5: { bar: "bg-red-500", dot: "bg-red-500", text: "text-red-600", label: "Kritis (5%)" },
  depleted: { bar: "bg-red-600", dot: "bg-red-600", text: "text-red-700", label: "Habis" },
};

export function quotaTone(level: string | null | undefined): QuotaTone {
  return TONES[(level as NotifyLevel) ?? "ok"] ?? TONES.ok;
}

export function fmtNum(n: number | null | undefined): string {
  return new Intl.NumberFormat("id-ID").format(n ?? 0);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// Whole days from now until the ISO date (>=0), for the "reset dalam N hari"
// countdown. null when the date is missing/invalid.
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
