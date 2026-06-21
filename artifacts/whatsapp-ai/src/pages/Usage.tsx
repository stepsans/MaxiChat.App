import { useState } from "react";
import {
  useGetMyAiUsage,
  getGetMyAiUsageQueryKey,
  useGetMyAiUsageByChannel,
  getGetMyAiUsageByChannelQueryKey,
  useGetMyAiUsageDaily,
  getGetMyAiUsageDailyQueryKey,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/use-permissions";
import {
  quotaTone,
  fmtNum,
  fmtDate,
  daysUntil,
} from "@/lib/quota-display";
import {
  Cpu,
  MessageSquareText,
  Sparkles,
  ShieldAlert,
  Infinity as InfinityIcon,
  Gift,
  Zap,
  CalendarClock,
  TrendingDown,
  AlertTriangle,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  Tooltip as RTooltip,
  Cell,
} from "recharts";

export default function Usage() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.usage.canView;
  const [days, setDays] = useState(30);

  const { data, isLoading } = useGetMyAiUsage({
    query: {
      queryKey: getGetMyAiUsageQueryKey(),
      refetchInterval: 30_000,
      enabled: canView,
      retry: false,
    },
  });
  const { data: byChannel } = useGetMyAiUsageByChannel({
    query: {
      queryKey: getGetMyAiUsageByChannelQueryKey(),
      enabled: canView,
      retry: false,
    },
  });
  const { data: daily } = useGetMyAiUsageDaily(
    { days },
    {
      query: {
        queryKey: getGetMyAiUsageDailyQueryKey({ days }),
        enabled: canView,
        retry: false,
      },
    }
  );

  if (!permLoading && !canView) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
            <CardDescription>
              Anda tidak memiliki izin untuk melihat pemakaian token AI.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const loading = permLoading || isLoading;
  const uncapped = !loading && (data?.tokenLimit ?? 0) <= 0;
  const tone = quotaTone(data?.notifyLevel);
  const pct = Math.min(100, data?.usagePercent ?? 0);
  const resetDays = daysUntil(data?.periodEnd);
  const blocked = data?.notifyLevel === "depleted";

  const secondary = [
    { label: "Total Token", value: data?.totalTokens ?? 0, Icon: Cpu },
    { label: "Token Prompt", value: data?.promptTokens ?? 0, Icon: MessageSquareText },
    { label: "Token Jawaban", value: data?.completionTokens ?? 0, Icon: Sparkles },
    { label: "Jumlah Panggilan AI", value: data?.requestCount ?? 0, Icon: MessageSquareText },
  ];

  const channelMax = Math.max(1, ...(byChannel ?? []).map((c) => c.totalTokens));
  const dailyData = (daily ?? []).map((d) => ({
    date: d.date.slice(5), // MM-DD
    tokens: d.totalTokens,
  }));

  return (
    <div className="max-w-5xl mx-auto py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Pemakaian Token AI
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sisa kuota dan estimasi habis untuk akun Anda. Pemakaian mencakup
            seluruh tim & channel akun Anda.
          </p>
        </div>
        {!loading && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              {data?.isInfinity ? <InfinityIcon className="w-3 h-3" /> : null}
              {data?.planName ?? "—"}
            </Badge>
            {data?.isTrial && <Badge variant="outline">Trial</Badge>}
          </div>
        )}
      </div>

      {/* Threshold alert — the loud 80%/0% nudge (spec E1) */}
      {!loading && !uncapped && data?.notifyLevel !== "ok" && (
        <div
          className={`rounded-lg border p-4 flex items-start gap-3 ${
            blocked
              ? "border-red-300 bg-red-50 dark:bg-red-950/30"
              : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"
          }`}
        >
          <AlertTriangle className={`w-5 h-5 mt-0.5 ${tone.text}`} />
          <div className="text-sm">
            <p className={`font-medium ${tone.text}`}>
              {blocked
                ? "Kuota token AI habis — fitur AI dihentikan sementara."
                : `Kuota token AI Anda ${tone.label.toLowerCase()} (${pct}% terpakai).`}
            </p>
            <p className="text-muted-foreground mt-0.5">
              {blocked
                ? "Auto-reply WhatsApp memakai pesan fallback statis. Tambah kuota atau beli booster untuk mengaktifkan AI kembali."
                : "Tambah kuota atau beli booster agar balasan AI tidak berhenti."}
            </p>
          </div>
        </div>
      )}

      {/* Hero: remaining quota + bar + breakdown + forecast */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-base">Sisa Kuota Token</CardTitle>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="w-3.5 h-3.5" />
              {loading ? (
                <Skeleton className="h-4 w-40" />
              ) : (
                <span>
                  Periode {fmtDate(data?.periodStart)} – {fmtDate(data?.periodEnd)}
                  {resetDays != null && !uncapped
                    ? ` · reset dalam ${resetDays} hari`
                    : ""}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : uncapped ? (
            <div className="flex items-center gap-2 text-lg font-semibold">
              <InfinityIcon className="w-5 h-5 text-primary" />
              {data?.isInfinity ? "Tanpa batas (Infinity)" : "Belum ada plafon kuota"}
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-3xl font-semibold tabular-nums">
                    {fmtNum(data?.tokenRemaining)}
                    <span className="text-base font-normal text-muted-foreground">
                      {" "}/ {fmtNum(data?.tokenLimit)} token
                    </span>
                  </div>
                  <div className={`text-sm mt-0.5 ${tone.text}`}>
                    {pct}% terpakai · {tone.label}
                  </div>
                </div>
                {data?.projectedDaysRemaining != null && (
                  <div className="text-right">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                      <TrendingDown className="w-3.5 h-3.5" /> Estimasi habis
                    </div>
                    <div className="text-lg font-medium">
                      ~{data.projectedDaysRemaining} hari
                    </div>
                  </div>
                )}
              </div>

              {/* Custom colored bar (color follows threshold) */}
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${tone.bar}`}
                  style={{ width: `${pct}%` }}
                  data-testid="quota-bar"
                />
              </div>

              {/* Grant vs booster breakdown (two buckets) */}
              <div className="grid sm:grid-cols-2 gap-3 pt-1">
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Gift className="w-3.5 h-3.5" /> Grant bulanan
                  </div>
                  <div className="text-lg font-semibold tabular-nums mt-0.5">
                    {fmtNum(data?.grantRemaining)} / {fmtNum(data?.grantLimit)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Hangus saat reset · {fmtDate(data?.grantResetAt)}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Zap className="w-3.5 h-3.5" /> Booster berbayar
                  </div>
                  <div className="text-lg font-semibold tabular-nums mt-0.5">
                    {fmtNum(data?.boosterRemaining)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data?.boosterNextExpiresAt
                      ? `Terdekat kedaluwarsa ${fmtDate(data.boosterNextExpiresAt)}`
                      : "Tidak ada booster aktif"}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Daily trend */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-base">Tren Pemakaian Harian</CardTitle>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 hari</SelectItem>
                <SelectItem value="30">30 hari</SelectItem>
                <SelectItem value="90">90 hari</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {dailyData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Belum ada pemakaian pada rentang ini.
            </p>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={20}
                  />
                  <RTooltip
                    formatter={(v: number) => [fmtNum(v), "Token"]}
                    labelClassName="text-xs"
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="tokens" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-channel breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pemakaian per Channel</CardTitle>
          <CardDescription>
            Channel mana yang paling banyak memakai token periode ini.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(byChannel ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Belum ada pemakaian per channel.
            </p>
          ) : (
            <div className="space-y-3">
              {(byChannel ?? [])
                .slice()
                .sort((a, b) => b.totalTokens - a.totalTokens)
                .map((c) => (
                  <div key={`${c.channelId}-${c.channelName}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate">
                        {c.channelName}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({c.channelType})
                        </span>
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {fmtNum(c.totalTokens)} · {fmtNum(c.requestCount)}×
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted mt-1">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(c.totalTokens / channelMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Secondary raw metrics (diagnostic) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Rincian Mentah</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {secondary.map((s) => (
              <div
                key={s.label}
                data-testid={`usage-stat-${s.label}`}
                className="rounded-lg border border-border bg-card/50 p-4"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                  <s.Icon className="w-3.5 h-3.5" />
                  {s.label}
                </div>
                {loading ? (
                  <Skeleton className="h-7 w-20 mt-2" />
                ) : (
                  <div className="text-xl font-semibold mt-1.5 tabular-nums">
                    {fmtNum(s.value)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <ChartLessFootnote />
    </div>
  );
}

function ChartLessFootnote() {
  return (
    <p className="text-xs text-muted-foreground">
      Token dihitung sejak fitur ini aktif. Periode berikutnya dimulai otomatis
      pada tanggal anniversary akun Anda.
    </p>
  );
}
