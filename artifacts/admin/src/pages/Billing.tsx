import { useMemo, useState } from "react";
import {
  useAdminListBilling,
  getAdminListBillingQueryKey,
  type AdminTenantBilling,
} from "@workspace/api-client-react";
import { Loader2, RefreshCw, Search, Wallet } from "lucide-react";

function fmtRp(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(n);
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  trial: {
    label: "Trial",
    cls: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  },
  active: {
    label: "Aktif",
    cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  expired: {
    label: "Kedaluwarsa",
    cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
  suspended: {
    label: "Ditangguhkan",
    cls: "bg-red-500/15 text-red-400 border-red-500/30",
  },
};

export default function Billing() {
  const [search, setSearch] = useState("");
  const { data, isLoading, isFetching, refetch } = useAdminListBilling({
    query: {
      queryKey: getAdminListBillingQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const rows = (data as AdminTenantBilling[] | undefined) ?? [];

  const grandTotal = useMemo(
    () => rows.reduce((acc, r) => acc + r.breakdown.total, 0),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...rows].sort((a, b) => b.breakdown.total - a.breakdown.total);
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
            Tagihan Tenant
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Estimasi tagihan bulanan tiap tenant berdasarkan pemakaian aktual
            dan harga yang berlaku.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-billing"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Muat ulang
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="text-left p-3 rounded-md border border-border bg-card">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Jumlah Tenant
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums">
            {fmtNum(rows.length)}
          </div>
        </div>
        <div className="text-left p-3 rounded-md border border-border bg-card sm:col-span-2">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Total Estimasi Tagihan (semua tenant)
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums">
            {fmtRp(grandTotal)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari tenant..."
            data-testid="search-billing"
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="border border-border rounded-md overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Tenant</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Periode s/d</th>
                <th className="text-right px-3 py-2 font-medium">DB</th>
                <th className="text-right px-3 py-2 font-medium">User</th>
                <th className="text-right px-3 py-2 font-medium">Channel</th>
                <th className="text-right px-3 py-2 font-medium">Token</th>
                <th className="text-right px-3 py-2 font-medium">Tagihan</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={8}
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
                    colSpan={8}
                    className="px-3 py-8 text-center text-muted-foreground text-xs"
                  >
                    Belum ada data tagihan.
                  </td>
                </tr>
              )}
              {filtered.map((r) => {
                const s = STATUS_MAP[r.status] ?? {
                  label: r.status,
                  cls: "bg-muted text-muted-foreground border-border",
                };
                return (
                  <tr
                    key={r.userId}
                    data-testid={`billing-row-${r.userId}`}
                    className="border-t border-border hover:bg-muted/30"
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium flex items-center gap-1.5">
                        <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
                        {r.name?.trim() || r.email}
                      </div>
                      {r.name?.trim() && (
                        <div className="text-[11px] text-muted-foreground">
                          {r.email}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border ${s.cls}`}
                      >
                        {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDate(r.currentPeriodEnd)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      <div className="tabular-nums">
                        {fmtRp(r.breakdown.dbCharge)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {fmtBytes(r.usage.storageBytes)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      <div className="tabular-nums">
                        {fmtRp(r.breakdown.userCharge)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {fmtNum(r.usage.childUserCount)} user
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      <div className="tabular-nums">
                        {fmtRp(r.breakdown.channelCharge)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {fmtNum(r.usage.channelCount)} ch
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      <div className="tabular-nums">
                        {fmtRp(r.breakdown.aiCharge)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {fmtNum(r.usage.tokenUsage)} tok
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {fmtRp(r.breakdown.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Tagihan dihitung dari pemakaian periode berjalan tiap tenant (periode
        mengikuti tanggal join). Token dihitung pada periode berjalan;
        penyimpanan, user, dan channel dihitung dari kondisi saat ini.
      </p>
    </div>
  );
}
