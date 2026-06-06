import {
  useGetMyBilling,
  getGetMyBillingQueryKey,
} from "@workspace/api-client-react";
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
import {
  Wallet,
  Database,
  Users as UsersIcon,
  MessageSquare,
  Cpu,
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
  const status = data?.subscription.status ?? "active";
  const statusInfo = STATUS_MAP[status] ?? {
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
    {
      label: "Token AI",
      Icon: Cpu,
      detail: data ? `${fmtNum(data.usage.tokenUsage)} token` : "—",
      rate: data
        ? `${fmtRp(data.pricing.aiPricePer100Tokens)} / 100 token`
        : "—",
      charge: data?.breakdown.aiCharge ?? 0,
    },
  ];

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-6">
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

      <p className="text-xs text-muted-foreground">
        Pemakaian token dihitung pada periode berjalan (mengikuti tanggal
        bergabung). Penyimpanan, jumlah user, dan channel dihitung dari kondisi
        saat ini. Tagihan ini bersifat estimasi.
      </p>
    </div>
  );
}
