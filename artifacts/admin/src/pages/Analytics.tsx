import { useMemo } from "react";
import {
  useAdminGetRevenue,
  getAdminGetRevenueQueryKey,
  type RevenueSummary,
} from "@workspace/api-client-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
} from "recharts";
import {
  Loader2,
  TrendingUp,
  CalendarRange,
  Users as UsersIcon,
  DollarSign,
} from "lucide-react";

function fmtRp(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(n));
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function StatCard({
  label,
  value,
  sub,
  Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  Icon: typeof TrendingUp;
}) {
  return (
    <div className="p-4 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {sub && (
        <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
      )}
    </div>
  );
}

export default function Analytics() {
  const { data, isLoading, isFetching, refetch } = useAdminGetRevenue(
    undefined,
    {
      query: {
        queryKey: getAdminGetRevenueQueryKey(),
        refetchInterval: 60_000,
      },
    }
  );

  const summary = data as RevenueSummary | undefined;

  const trend = useMemo(
    () =>
      (summary?.trend ?? []).map((p) => ({
        date: p.date.slice(5),
        total: p.totalCharge,
      })),
    [summary]
  );

  if (isLoading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Memuat...
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Analitik Pendapatan
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            MRR/ARR dan komposisi tenant berdasarkan estimasi tagihan periode
            berjalan tiap tenant.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-revenue"
        >
          <Loader2
            className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : "hidden"}`}
          />
          Muat ulang
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="MRR"
          value={fmtRp(summary?.mrr ?? 0)}
          sub="Pendapatan bulanan berulang"
          Icon={DollarSign}
        />
        <StatCard
          label="ARR"
          value={fmtRp(summary?.arr ?? 0)}
          sub="MRR × 12"
          Icon={CalendarRange}
        />
        <StatCard
          label="ARPU"
          value={fmtRp(summary?.arpu ?? 0)}
          sub={`${fmtNum(summary?.payingTenants ?? 0)} tenant membayar`}
          Icon={TrendingUp}
        />
        <StatCard
          label="Total Tenant"
          value={fmtNum(summary?.totalTenants ?? 0)}
          sub={`${fmtNum(summary?.activeTenants ?? 0)} aktif`}
          Icon={UsersIcon}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 rounded-md border border-border bg-card">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Aktif
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums text-emerald-400">
            {fmtNum(summary?.activeTenants ?? 0)}
          </div>
        </div>
        <div className="p-3 rounded-md border border-border bg-card">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Trial
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums text-sky-400">
            {fmtNum(summary?.trialTenants ?? 0)}
          </div>
        </div>
        <div className="p-3 rounded-md border border-border bg-card">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Kedaluwarsa
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums text-amber-400">
            {fmtNum(summary?.expiredTenants ?? 0)}
          </div>
        </div>
        <div className="p-3 rounded-md border border-border bg-card">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Ditangguhkan
          </div>
          <div className="text-lg font-semibold mt-0.5 tabular-nums text-red-400">
            {fmtNum(summary?.suspendedTenants ?? 0)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-semibold flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-primary" />
          Tren Pendapatan Harian (30 hari)
        </div>
        {trend.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            Belum ada data snapshot harian.
          </div>
        ) : (
          <div className="h-64" data-testid="chart-revenue-trend">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={trend}
                margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
              >
                <defs>
                  <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                  width={80}
                  tickFormatter={(v) => fmtRp(Number(v))}
                />
                <RechartsTooltip
                  formatter={(v) => [fmtRp(Number(v)), "Total"]}
                  labelFormatter={(l) => `Tanggal ${l}`}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#revFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        MRR dihitung dari invoice penagihan bulanan (monthly close) terbaru tiap
        tenant yang berstatus efektif aktif. Tren harian menjumlahkan seluruh
        invoice (langganan + pembelian) berdasarkan tanggal terbit.
      </p>
    </div>
  );
}
