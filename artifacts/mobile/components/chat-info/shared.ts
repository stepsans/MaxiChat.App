/** Format an integer Rupiah amount the Indonesian way (e.g. 34000 -> "Rp34.000"). */
export function formatRupiah(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "-";
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

/** Short date/time label for list rows. */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
