import { useMemo, useState } from "react";
import {
  useAdminListAiUsage,
  getAdminListAiUsageQueryKey,
  type AiUsageSummary,
} from "@workspace/api-client-react";
import { Loader2, RefreshCw, Search, Cpu } from "lucide-react";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

export default function TokenUsage() {
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch } = useAdminListAiUsage({
    query: { queryKey: getAdminListAiUsageQueryKey(), refetchInterval: 30_000 },
  });

  const rows = (data as AiUsageSummary[] | undefined) ?? [];

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.prompt += r.promptTokens;
        acc.completion += r.completionTokens;
        acc.total += r.totalTokens;
        acc.requests += r.requestCount;
        return acc;
      },
      { prompt: 0, completion: 0, total: 0, requests: 0 }
    );
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
    if (!q) return sorted;
    return sorted.filter(
      (r) =>
        r.email.toLowerCase().includes(q) ||
        (r.name ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Pemakaian Token AI
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pemakaian token per super admin untuk periode berjalan. Periode
            dihitung bulanan mengikuti <strong>tanggal join</strong> tiap super
            admin.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-usage"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Muat ulang
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(
          [
            { label: "Total Token", value: totals.total },
            { label: "Token Prompt", value: totals.prompt },
            { label: "Token Jawaban", value: totals.completion },
            { label: "Jumlah Panggilan", value: totals.requests },
          ] as const
        ).map((s) => (
          <div
            key={s.label}
            className="text-left p-3 rounded-md border border-border bg-card"
          >
            <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
              {s.label}
            </div>
            <div className="text-lg font-semibold mt-0.5 tabular-nums">
              {fmtNum(s.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari super admin..."
            data-testid="search-usage"
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="border border-border rounded-md overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Super Admin</th>
                <th className="text-left px-3 py-2 font-medium">Tgl Join</th>
                <th className="text-left px-3 py-2 font-medium">
                  Periode Berjalan
                </th>
                <th className="text-right px-3 py-2 font-medium">Prompt</th>
                <th className="text-right px-3 py-2 font-medium">Jawaban</th>
                <th className="text-right px-3 py-2 font-medium">Total</th>
                <th className="text-right px-3 py-2 font-medium">Panggilan</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                    Memuat...
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-muted-foreground text-xs"
                  >
                    Belum ada data pemakaian token.
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.userId}
                  data-testid={`usage-row-${r.userId}`}
                  className="border-t border-border hover:bg-muted/30"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
                      {r.name?.trim() || r.email}
                    </div>
                    {r.name?.trim() && (
                      <div className="text-[11px] text-muted-foreground">
                        {r.email}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {fmtDate(r.joinedAt)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtNum(r.promptTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtNum(r.completionTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {fmtNum(r.totalTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtNum(r.requestCount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Token mulai dihitung sejak fitur ini aktif — pemakaian sebelumnya tidak
        tersedia. Setiap super admin memakai token (kuota AI) miliknya sendiri.
      </p>
    </div>
  );
}
