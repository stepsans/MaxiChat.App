import {
  useGetMyBilling,
  getGetMyBillingQueryKey,
  useGetMyBillingTrend,
  getGetMyBillingTrendQueryKey,
  useGetMyWallet,
  getGetMyWalletQueryKey,
  type WalletSummary,
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { usePermissions } from "@/hooks/use-permissions";
import CheckoutSection from "@/components/CheckoutSection";
import ChangePlanSection from "@/components/ChangePlanSection";
import CreditWalletCard from "@/components/CreditWalletCard";
import InvoiceHistory from "@/components/InvoiceHistory";
import {
  Wallet,
  Database,
  Users as UsersIcon,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";

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
    month: "long",
    year: "numeric",
  });
}

const WALLET_KIND_LABEL: Record<string, string> = {
  topup: "Top-up",
  proration_credit: "Kredit proporsional",
  downgrade_credit: "Kredit penurunan paket",
  debit: "Pemakaian saldo",
  cart_payment: "Pembayaran",
  invoice_payment: "Pembayaran invoice",
  adjustment: "Penyesuaian",
  expiry: "Kedaluwarsa",
};

function WalletCard() {
  const { data, isLoading } = useGetMyWallet({
    query: {
      queryKey: getGetMyWalletQueryKey(),
      refetchInterval: 60_000,
      retry: false,
    },
  });
  const wallet = data as WalletSummary | undefined;
  const txns = wallet?.transactions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          Saldo Kredit
        </CardTitle>
        <CardDescription>
          Kredit dipakai otomatis lebih dulu saat membayar tagihan atau membeli
          paket.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2 mb-3">
          {isLoading ? (
            <Skeleton className="h-8 w-32" />
          ) : (
            <span
              className="text-2xl font-bold tabular-nums text-primary"
              data-testid="wallet-balance"
            >
              {fmtRp(wallet?.balanceIdr ?? 0)}
            </span>
          )}
        </div>
        {txns.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="wallet-empty"
          >
            Belum ada transaksi saldo.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Tanggal</th>
                  <th className="py-2 pr-3 font-medium">Keterangan</th>
                  <th className="py-2 font-medium text-right">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr
                    key={t.id}
                    data-testid={`wallet-txn-${t.id}`}
                    className="border-b border-border/50"
                  >
                    <td className="py-2 pr-3 whitespace-nowrap text-xs">
                      {fmtDate(t.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      {WALLET_KIND_LABEL[t.kind] ?? t.kind}
                    </td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        t.deltaIdr >= 0 ? "text-emerald-500" : "text-foreground"
                      }`}
                    >
                      {t.deltaIdr >= 0 ? "+" : "−"}
                      {fmtRp(Math.abs(t.deltaIdr))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_MAP: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  trial: { label: "Trial", variant: "secondary" },
  active: { label: "Aktif", variant: "default" },
  expired: { label: "Kedaluwarsa", variant: "destructive" },
  suspended: { label: "Ditangguhkan", variant: "destructive" },
};

export default function Billing() {
  const { isSuperAdmin, isLoading: permLoading } = usePermissions();

  const { data, isLoading } = useGetMyBilling({
    query: {
      queryKey: getGetMyBillingQueryKey(),
      refetchInterval: 60_000,
      enabled: isSuperAdmin,
      retry: false,
    },
  });

  const { data: trendData, isLoading: trendLoading } = useGetMyBillingTrend(
    { days: 30 },
    {
      query: {
        queryKey: getGetMyBillingTrendQueryKey({ days: 30 }),
        enabled: isSuperAdmin,
        retry: false,
      },
    }
  );
  const trend = (trendData?.trend ?? []).map((p) => ({
    date: p.date.slice(5),
    total: p.totalCharge,
  }));

  // Route is unguarded — self-guard so non-owners get a clear message.
  if (!permLoading && !isSuperAdmin) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
            <CardDescription>
              Hanya pemilik akun (super admin) yang dapat melihat langganan dan
              tagihan.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const loading = permLoading || isLoading;
  const unlimited = data?.unlimited ?? false;
  const status = data?.subscription.status ?? "active";
  const statusInfo = unlimited
    ? { label: data?.planLabel ?? "Owner Infinity", variant: "default" as const }
    : STATUS_MAP[status] ?? {
        label: status,
        variant: "outline" as const,
      };

  const lines = [
    {
      label: "Penyimpanan Database",
      Icon: Database,
      detail: data ? fmtBytes(data.usage.storageBytes) : "—",
      rate: data
        ? `${fmtRp(data.pricing.dbPricePer500Mb)} / 500 MB`
        : "—",
      charge: data?.breakdown.dbCharge ?? 0,
    },
    {
      label: "User Tim",
      Icon: UsersIcon,
      detail: data ? `${fmtNum(data.usage.childUserCount)} user` : "—",
      rate: data ? `${fmtRp(data.pricing.userPricePerUser)} / user` : "—",
      charge: data?.breakdown.userCharge ?? 0,
    },
    {
      label: "Channel",
      Icon: MessageSquare,
      detail: data ? `${fmtNum(data.usage.channelCount)} channel` : "—",
      rate: data ? `${fmtRp(data.pricing.channelPricePer2)} / 2 channel` : "—",
      charge: data?.breakdown.channelCharge ?? 0,
    },
    // NOTE: AI is no longer metered here — it rides the prepaid credit wallet.
    // The credit-balance widget is added in Langkah 9 (SPEC BAGIAN 13.2).
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto py-6 px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Langganan &amp; Tagihan
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Estimasi tagihan bulanan akun Anda berdasarkan pemakaian aktual.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Status Langganan</CardTitle>
              <CardDescription className="mt-1">
                {loading ? (
                  <Skeleton className="h-4 w-56" />
                ) : unlimited ? (
                  <>Akses penuh tanpa batas — berlaku selamanya, tanpa tagihan</>
                ) : data?.subscription.currentPeriodEnd == null &&
                  data?.subscription.status === "active" ? (
                  <>Berlaku selamanya</>
                ) : (
                  <>Berlaku hingga {fmtDate(data?.subscription.currentPeriodEnd)}</>
                )}
              </CardDescription>
            </div>
            {loading ? (
              <Skeleton className="h-6 w-16" />
            ) : (
              <Badge variant={statusInfo.variant} data-testid="subscription-status">
                {statusInfo.label}
              </Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {unlimited ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className="w-4 h-4 text-primary" />
              {data?.planLabel ?? "Owner Infinity"}
            </CardTitle>
            <CardDescription>
              Akun ini memiliki kuota tak terbatas dan tidak dikenakan tagihan.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {lines.map((l) => (
                <div
                  key={l.label}
                  data-testid={`bill-line-${l.label}`}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <l.Icon className="w-3.5 h-3.5 text-muted-foreground" />
                      {l.label}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {loading ? <Skeleton className="h-3 w-32" /> : l.detail}
                    </div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums whitespace-nowrap text-primary">
                    ∞
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-4 pt-4 mt-2 border-t border-border">
              <div className="text-sm font-semibold">Total / bulan</div>
              <div
                className="text-xl font-bold tabular-nums text-primary"
                data-testid="bill-total"
              >
                {fmtRp(0)}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
      <WalletCard />

      <CreditWalletCard
        onTopup={() =>
          document.getElementById("checkout-section")?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      />

      <ChangePlanSection />

      <div id="checkout-section">
        <CheckoutSection />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="w-4 h-4 text-primary" />
            Rincian Tagihan
          </CardTitle>
          <CardDescription>
            Pemakaian periode berjalan dikalikan tarif yang berlaku.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border">
            {lines.map((l) => (
              <div
                key={l.label}
                data-testid={`bill-line-${l.label}`}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-1.5">
                    <l.Icon className="w-3.5 h-3.5 text-muted-foreground" />
                    {l.label}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {loading ? (
                      <Skeleton className="h-3 w-32" />
                    ) : (
                      <>
                        {l.detail} · {l.rate}
                      </>
                    )}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums whitespace-nowrap">
                  {loading ? (
                    <Skeleton className="h-4 w-20" />
                  ) : (
                    fmtRp(l.charge)
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-4 pt-4 mt-2 border-t border-border">
            <div className="text-sm font-semibold">Total Estimasi / bulan</div>
            <div
              className="text-xl font-bold tabular-nums text-primary"
              data-testid="bill-total"
            >
              {loading ? (
                <Skeleton className="h-6 w-28" />
              ) : (
                fmtRp(data?.breakdown.total ?? 0)
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="w-4 h-4 text-primary" />
            Tren Pengeluaran (30 hari)
          </CardTitle>
          <CardDescription>
            Estimasi tagihan harian akun Anda berdasarkan snapshot pemakaian.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trendLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : trend.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
              Belum ada data pemakaian harian.
            </div>
          ) : (
            <div className="h-56" data-testid="chart-spend-trend">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                  <defs>
                    <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
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
                    width={70}
                    tickFormatter={(v) => fmtRp(Number(v))}
                  />
                  <RechartsTooltip
                    formatter={(v) => [fmtRp(Number(v)), "Tagihan"]}
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
                    fill="url(#spendFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Pemakaian token dihitung pada periode berjalan (mengikuti tanggal
        bergabung). Penyimpanan, jumlah user, dan channel dihitung dari kondisi
        saat ini. Tagihan ini bersifat estimasi.
      </p>
        </>
      )}

      <InvoiceHistory />
      </div>
    </div>
  );
}
