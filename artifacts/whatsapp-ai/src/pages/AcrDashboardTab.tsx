// AI Chat Report — Dashboard KPI (Bagian III).
// Cross-period team aggregates read from acr_kpi_snapshots via GET /acr/dashboard.
// Super-admin only (the endpoint enforces it; the tab is also gated in the page).
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAcrDashboard,
  useListAcrAlerts,
  getListAcrAlertsQueryKey,
  useResolveAcrAlert,
  useListAcrTargets,
  useListAcrAchievements,
  useGetAcrMomReport,
  getGetAcrMomReportQueryKey,
  useGetAcrBenchmark,
  getGetAcrBenchmarkQueryKey,
  type AcrAgentScore,
  type AcrKpiSnapshot,
  type GetAcrDashboardFrequency,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitCompare,
  Star,
  Target,
  Trophy,
  Wallet,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const GRADE_COLORS: Record<string, string> = {
  A: "bg-emerald-600",
  B: "bg-sky-600",
  C: "bg-amber-500",
  D: "bg-orange-600",
  E: "bg-red-600",
};

const n1 = (v: number | null | undefined): string =>
  v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1);

function initials(name: string | null | undefined): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
      {initials(name)}
    </span>
  );
}

function Delta({
  curr,
  prev,
  betterWhenLower = false,
  suffix = "",
}: {
  curr: number | null | undefined;
  prev: number | null | undefined;
  betterWhenLower?: boolean;
  suffix?: string;
}) {
  if (curr == null || prev == null) return <span className="text-xs text-muted-foreground">──</span>;
  const d = curr - prev;
  if (Math.abs(d) < 0.05) return <span className="text-xs text-muted-foreground">── stabil</span>;
  const improved = betterWhenLower ? d < 0 : d > 0;
  const arrow = d > 0 ? "▲" : "▼";
  return (
    <span className={cn("text-xs", improved ? "text-emerald-600" : "text-red-600")}>
      {arrow} {d > 0 ? "+" : ""}
      {Math.round(d * 10) / 10}
      {suffix} vs lalu
    </span>
  );
}

function MetricCard({
  title,
  value,
  delta,
  icon,
}: {
  title: string;
  value: string;
  delta: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-xs">{title}</span>
          {icon}
        </div>
        <div className="mt-1 text-2xl font-bold">{value}</div>
        <div className="mt-0.5">{delta}</div>
      </CardContent>
    </Card>
  );
}

// One leaderboard card: agents ranked by `value`, horizontal bar relative to the
// highest value in the set.
function LeaderboardCard({
  title,
  icon,
  rows,
  value,
  display,
  ascending = false,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  rows: AcrAgentScore[];
  value: (r: AcrAgentScore) => number;
  display: (r: AcrAgentScore) => string;
  ascending?: boolean;
  footer?: string;
}) {
  const sorted = [...rows].sort((a, b) => (ascending ? value(a) - value(b) : value(b) - value(a)));
  const max = Math.max(1, ...sorted.map((r) => Math.abs(value(r))));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sorted.length === 0 && <p className="text-xs text-muted-foreground">Belum ada data.</p>}
        {sorted.slice(0, 6).map((r, i) => (
          <div key={r.agentUserId} className="flex items-center gap-2">
            <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
            <Avatar name={r.agentName} />
            <span className="w-24 truncate text-sm">{r.agentName ?? `#${r.agentUserId}`}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full rounded bg-primary"
                style={{ width: `${(Math.abs(value(r)) / max) * 100}%` }}
              />
            </div>
            <span className="w-16 text-right text-sm font-medium tabular-nums">{display(r)}</span>
          </div>
        ))}
        {footer && <p className="pt-1 text-xs text-muted-foreground">{footer}</p>}
      </CardContent>
    </Card>
  );
}

const FREQ_OPTIONS = [
  { value: "all", label: "Semua" },
  { value: "daily", label: "Harian" },
  { value: "weekly", label: "Mingguan" },
  { value: "monthly", label: "Bulanan" },
  { value: "manual", label: "Manual" },
] as const;

const RED_FLAG_SERIES = [
  { key: "totalCustomerAngry", label: "Customer Tidak Puas", color: "#dc2626" },
  { key: "totalRudeLanguage", label: "Bahasa Tidak Sopan", color: "#7f1d1d" },
  { key: "totalCustomerIgnored", label: "Customer Dicuekin", color: "#ea580c" },
  { key: "totalNoReplyCritical", label: "Tidak Dibalas", color: "#475569" },
  { key: "totalAnswerDropout", label: "Jawaban Dropout", color: "#9333ea" },
] as const;

export default function AcrDashboardTab() {
  const [, navigate] = useLocation();
  const [frequency, setFrequency] = useState<string>("all");
  const { data, isLoading } = useGetAcrDashboard({
    frequency: frequency as GetAcrDashboardFrequency,
    limit: 12,
  });

  const qc = useQueryClient();
  const { toast } = useToast();

  const periods = data?.periods ?? [];
  const current = data?.current ?? null;
  const previous = data?.previous ?? null;
  const leaderboard = data?.leaderboard ?? [];
  const agentTrends = data?.agentTrends ?? [];

  // Bagian IV widgets data.
  const { data: alerts } = useListAcrAlerts({ unresolvedOnly: true });
  const { data: targets } = useListAcrTargets();
  const { data: achievements } = useListAcrAchievements();
  const resolveAlert = useResolveAcrAlert();

  const [showMom, setShowMom] = useState(false);
  const momParams = {
    currentJobId: current?.jobId ?? "",
    previousJobId: previous?.jobId ?? "",
  };
  const momQ = useGetAcrMomReport(momParams, {
    query: {
      enabled: showMom && !!current && !!previous,
      queryKey: getGetAcrMomReportQueryKey(momParams),
    },
  });
  const [showBench, setShowBench] = useState(false);
  const benchParams = { jobId: current?.jobId ?? "" };
  const benchQ = useGetAcrBenchmark(benchParams, {
    query: {
      enabled: showBench && !!current,
      queryKey: getGetAcrBenchmarkQueryKey(benchParams),
    },
  });

  const trendData = useMemo(
    () =>
      periods.map((p) => ({
        label: p.periodLabel,
        total: p.teamAvgScore ?? 0,
        rt: p.teamAvgResponseTime ?? 0,
        lang: p.teamAvgLanguage ?? 0,
        ans: p.teamAvgAnswer ?? 0,
        comp: p.teamAvgComplaint ?? 0,
      })),
    [periods]
  );

  const gradeData = useMemo(
    () =>
      periods.map((p) => ({
        label: p.periodLabel,
        A: p.countGradeA,
        B: p.countGradeB,
        C: p.countGradeC,
        D: p.countGradeD,
        E: p.countGradeE,
      })),
    [periods]
  );

  const redFlagData = useMemo(
    () =>
      periods.map((p) => ({
        label: p.periodLabel,
        totalCustomerAngry: p.totalCustomerAngry,
        totalRudeLanguage: p.totalRudeLanguage,
        totalCustomerIgnored: p.totalCustomerIgnored,
        totalNoReplyCritical: p.totalNoReplyCritical,
        totalAnswerDropout: p.totalAnswerDropout,
      })),
    [periods]
  );

  // Cross-period agent matrix (Section 4.6): columns = period labels.
  const matrix = useMemo(() => {
    const cols = periods.map((p) => p.periodLabel);
    const rows = agentTrends.map((a) => {
      const byLabel = new Map(a.points.map((pt) => [pt.periodLabel, pt.totalScore]));
      return {
        agentUserId: a.agentUserId,
        agentName: a.agentName,
        cells: cols.map((c) => byLabel.get(c) ?? null),
        last: a.points[a.points.length - 1]?.totalScore ?? null,
        first: a.points[0]?.totalScore ?? null,
      };
    });
    rows.sort((x, y) => (y.last ?? 0) - (x.last ?? 0));
    return { cols, rows };
  }, [periods, agentTrends]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="space-y-4">
        <FrequencyFilter value={frequency} onChange={setFrequency} />
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          Belum ada data dashboard untuk filter ini. Jalankan sebuah laporan dulu — KPI akan
          terisi otomatis saat laporan selesai.
        </div>
      </div>
    );
  }

  const answeredRate = (s: AcrKpiSnapshot): number | null => {
    const denom = s.totalConversations ?? 0;
    if (!denom) return null;
    return ((denom - (s.totalMissedChats ?? 0)) / denom) * 100;
  };

  return (
    <div className="space-y-6">
      <FrequencyFilter value={frequency} onChange={setFrequency} />

      {/* Row 1: metric cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          title="Rata-rata Skor Tim"
          value={`${n1(current.teamAvgScore)} / 100`}
          icon={<Star className="h-4 w-4" />}
          delta={<Delta curr={current.teamAvgScore} prev={previous?.teamAvgScore} />}
        />
        <MetricCard
          title="Red Flag Periode Ini"
          value={`${current.totalRedFlags}`}
          icon={<AlertTriangle className="h-4 w-4" />}
          delta={
            <Delta
              curr={current.totalRedFlags}
              prev={previous?.totalRedFlags}
              betterWhenLower
            />
          }
        />
        <MetricCard
          title="Chat Terjawab"
          value={answeredRate(current) == null ? "—" : `${n1(answeredRate(current))}%`}
          icon={<XCircle className="h-4 w-4" />}
          delta={
            <Delta
              curr={answeredRate(current)}
              prev={previous ? answeredRate(previous) : null}
              suffix="%"
            />
          }
        />
        <MetricCard
          title="Avg Waktu Balas"
          value={`${n1(current.teamAvgResponseTime)} mnt`}
          icon={<Clock className="h-4 w-4" />}
          delta={
            <Delta
              curr={current.teamAvgResponseTime}
              prev={previous?.teamAvgResponseTime}
              betterWhenLower
              suffix=" mnt"
            />
          }
        />
        <MetricCard
          title="Total Tunjangan"
          value={IDR.format(current.totalAllowanceAmount ?? 0)}
          icon={<Wallet className="h-4 w-4" />}
          delta={
            previous ? (
              <span className="text-xs text-muted-foreground">
                vs {IDR.format(previous.totalAllowanceAmount ?? 0)}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">──</span>
            )
          }
        />
      </div>

      {/* Row 2: team score trend */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Tren Skor Tim</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendData} margin={{ left: -16, right: 8, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
              <ChartTooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="total" name="Total Skor" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="rt" name="Kec. Balas" stroke="#16a34a" strokeWidth={1} dot={false} />
              <Line type="monotone" dataKey="lang" name="Bahasa" stroke="#9333ea" strokeWidth={1} dot={false} />
              <Line type="monotone" dataKey="ans" name="Ketepatan" stroke="#ea580c" strokeWidth={1} dot={false} />
              <Line type="monotone" dataKey="comp" name="Komplain" stroke="#0891b2" strokeWidth={1} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Row 3: grade distribution + red flag trend */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Distribusi Grade per Periode</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={gradeData} margin={{ left: -16, right: 8, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <ChartTooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="A" stackId="g" fill="#059669" />
                <Bar dataKey="B" stackId="g" fill="#0284c7" />
                <Bar dataKey="C" stackId="g" fill="#f59e0b" />
                <Bar dataKey="D" stackId="g" fill="#ea580c" />
                <Bar dataKey="E" stackId="g" fill="#dc2626" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tren Red Flag</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={redFlagData} margin={{ left: -16, right: 8, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <ChartTooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {RED_FLAG_SERIES.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stackId="rf"
                    stroke={s.color}
                    fill={s.color}
                    fillOpacity={0.5}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Row 4: per-dimension leaderboards (latest period) */}
      <div className="grid gap-3 lg:grid-cols-3">
        <LeaderboardCard
          title="Papan KPI Agent — Skor Total"
          icon={<Star className="h-4 w-4 text-amber-500" />}
          rows={leaderboard}
          value={(r) => r.totalScore}
          display={(r) => n1(r.totalScore)}
          footer="Nilai gabungan 0–100 dari semua dimensi."
        />
        <LeaderboardCard
          title="Kecepatan Balas (Tercepat)"
          icon={<Clock className="h-4 w-4 text-emerald-600" />}
          rows={leaderboard.filter((r) => r.avgResponseTimeMinutes != null)}
          value={(r) => r.avgResponseTimeMinutes ?? 0}
          display={(r) => `${n1(r.avgResponseTimeMinutes)} mnt`}
          ascending
        />
        <LeaderboardCard
          title="Chat Tidak Terjawab (Terbanyak)"
          icon={<XCircle className="h-4 w-4 text-red-600" />}
          rows={leaderboard}
          value={(r) => r.totalMissedChats ?? 0}
          display={(r) => `${r.totalMissedChats ?? 0}`}
        />
        <LeaderboardCard
          title="Kualitas Bahasa"
          icon={<Star className="h-4 w-4 text-purple-600" />}
          rows={leaderboard}
          value={(r) => r.scoreLanguageQuality ?? 0}
          display={(r) => n1(r.scoreLanguageQuality)}
        />
        <LeaderboardCard
          title="Ketepatan Jawaban"
          icon={<Star className="h-4 w-4 text-orange-600" />}
          rows={leaderboard}
          value={(r) => r.scoreAnswerQuality ?? 0}
          display={(r) => n1(r.scoreAnswerQuality)}
        />
        <LeaderboardCard
          title="Handling Komplain"
          icon={<Star className="h-4 w-4 text-cyan-600" />}
          rows={leaderboard}
          value={(r) => r.scoreComplaintHandling ?? 0}
          display={(r) => n1(r.scoreComplaintHandling)}
        />
      </div>

      {/* Row 5: full KPI table for the latest period */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Ringkasan KPI Per Agent — {current.periodLabel}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Kec. Balas</TableHead>
                <TableHead className="text-right">Bahasa</TableHead>
                <TableHead className="text-right">Ketepatan</TableHead>
                <TableHead className="text-right">Komplain</TableHead>
                <TableHead className="text-right">Missed</TableHead>
                <TableHead className="text-right">Red Flag</TableHead>
                <TableHead className="text-right">Tunjangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaderboard.map((r) => (
                <TableRow
                  key={r.agentUserId}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate(`/ai-chat-report/${current.jobId}?tab=agents&agent=${r.agentUserId}`)
                  }
                >
                  <TableCell className="flex items-center gap-2 font-medium">
                    <Avatar name={r.agentName} />
                    {r.agentName ?? `#${r.agentUserId}`}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white",
                        GRADE_COLORS[r.grade] ?? "bg-slate-500"
                      )}
                    >
                      {r.grade}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-semibold">{n1(r.totalScore)}</TableCell>
                  <TableCell className="text-right">
                    {n1(r.scoreResponseTime)}
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      ({n1(r.avgResponseTimeMinutes)}m)
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{n1(r.scoreLanguageQuality)}</TableCell>
                  <TableCell className="text-right">{n1(r.scoreAnswerQuality)}</TableCell>
                  <TableCell className="text-right">{n1(r.scoreComplaintHandling)}</TableCell>
                  <TableCell className="text-right">{r.totalMissedChats ?? 0}</TableCell>
                  <TableCell className="text-right">
                    {(r.redFlagCount ?? 0) > 0 ? (
                      <span className="text-red-600">{r.redFlagCount} 🔴</span>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell className="text-right">{IDR.format(r.allowanceAmount ?? 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Cross-period agent matrix */}
      {matrix.cols.length > 1 && matrix.rows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Performa Per Agent Lintas Periode</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    {matrix.cols.map((c) => (
                      <TableHead key={c} className="text-right whitespace-nowrap">
                        {c}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Tren</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matrix.rows.map((row) => {
                    const trend =
                      row.first != null && row.last != null ? row.last - row.first : null;
                    return (
                      <TableRow key={row.agentUserId}>
                        <TableCell className="flex items-center gap-2 font-medium">
                          <Avatar name={row.agentName} />
                          {row.agentName ?? `#${row.agentUserId}`}
                        </TableCell>
                        {row.cells.map((cell, i) => (
                          <TableCell key={i} className="text-right tabular-nums">
                            {cell == null ? "—" : n1(cell)}
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          {trend == null ? (
                            "—"
                          ) : trend >= 2 ? (
                            <span className="text-emerald-600">▲ 📈</span>
                          ) : trend <= -2 ? (
                            <span className="text-red-600">▼ ⚠️</span>
                          ) : (
                            <span className="text-muted-foreground">──</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
      {/* 9.2 Performance alerts */}
      {(alerts ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-orange-600" /> Alert Performa
              <Badge variant="secondary">{alerts!.length} aktif</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {alerts!.map((a) => {
              const agentName =
                leaderboard.find((r) => r.agentUserId === a.agentUserId)?.agentName ??
                `#${a.agentUserId}`;
              const color =
                a.severity === "critical"
                  ? "text-red-600"
                  : a.severity === "high"
                    ? "text-orange-600"
                    : "text-amber-600";
              return (
                <div key={a.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className={cn("text-sm font-medium", color)}>
                        {a.severity === "critical" ? "🔴" : "🟠"} {agentName} — {a.title}
                      </p>
                      {a.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
                      )}
                      {a.recommendation && (
                        <p className="mt-1 text-xs">💡 {a.recommendation}</p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        resolveAlert.mutate(
                          { id: a.id },
                          {
                            onSuccess: () => {
                              toast({ title: "Alert ditandai selesai." });
                              qc.invalidateQueries({ queryKey: getListAcrAlertsQueryKey() });
                            },
                          }
                        )
                      }
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Selesai
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* 9.1 Target progress + 9.6 Achievements */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Target className="h-4 w-4 text-sky-600" /> Progress Target KPI
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(targets ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada target. Atur di Pengaturan → Target KPI.
              </p>
            )}
            {(targets ?? []).map((t) => {
              const row = leaderboard.find((r) => r.agentUserId === t.agentUserId);
              const score = row?.totalScore ?? 0;
              const pct = t.targetScore > 0 ? (score / t.targetScore) * 100 : 0;
              const reached = score >= t.targetScore;
              return (
                <div key={t.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{row?.agentName ?? `#${t.agentUserId}`}</span>
                    <span className="text-muted-foreground">
                      {n1(score)} / {n1(t.targetScore)}{" "}
                      {reached ? "✅" : `(${(t.targetScore - score).toFixed(1)} lagi)`}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-muted">
                    <div
                      className={cn("h-full rounded", reached ? "bg-emerald-600" : "bg-sky-500")}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Trophy className="h-4 w-4 text-amber-500" /> Achievement Terbaru
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(achievements ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">Belum ada achievement.</p>
            )}
            {(achievements ?? []).slice(0, 8).map((a) => {
              const agentName =
                leaderboard.find((r) => r.agentUserId === a.agentUserId)?.agentName ??
                `#${a.agentUserId}`;
              return (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <span className="text-lg">{a.achievementIcon}</span>
                  <span className="font-medium">{agentName}</span>
                  <span className="text-muted-foreground">— {a.achievementName}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{a.earnedAtPeriod}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* 9.5 MoM report */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitCompare className="h-4 w-4" /> Perbandingan Periode (MoM)
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={!previous || momQ.isFetching}
            onClick={() => setShowMom(true)}
          >
            {momQ.isFetching ? "Memproses…" : "Buat Analisa"}
          </Button>
        </CardHeader>
        <CardContent>
          {!previous && (
            <p className="text-xs text-muted-foreground">
              Butuh minimal 2 periode untuk perbandingan.
            </p>
          )}
          {showMom && momQ.data && (
            <div className="space-y-2 text-sm">
              <p className="font-medium capitalize">Tren: {momQ.data.overall_trend}</p>
              <p className="text-muted-foreground">{momQ.data.executive_summary}</p>
              {(momQ.data.key_improvements ?? []).length > 0 && (
                <div>
                  <p className="font-medium text-emerald-600">Membaik:</p>
                  <ul className="ml-4 list-disc text-xs">
                    {momQ.data.key_improvements!.map((k, i) => (
                      <li key={i}>
                        {k.metric}: {k.change} — {k.possible_reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(momQ.data.key_declines ?? []).length > 0 && (
                <div>
                  <p className="font-medium text-red-600">Menurun:</p>
                  <ul className="ml-4 list-disc text-xs">
                    {momQ.data.key_declines!.map((k, i) => (
                      <li key={i}>
                        {k.metric}: {k.change} — {k.recommendation}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(momQ.data.strategic_recommendations ?? []).length > 0 && (
                <div>
                  <p className="font-medium">Rekomendasi:</p>
                  <ul className="ml-4 list-disc text-xs">
                    {momQ.data.strategic_recommendations!.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 9.3 Benchmark */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitCompare className="h-4 w-4" /> Benchmark Antar Tim
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={benchQ.isFetching}
            onClick={() => setShowBench(true)}
          >
            {benchQ.isFetching ? "Memproses…" : "Buat Benchmark"}
          </Button>
        </CardHeader>
        <CardContent>
          {showBench && benchQ.isError && (
            <p className="text-xs text-muted-foreground">
              Butuh minimal 2 tim (atur di Pengaturan → Tim/Shift).
            </p>
          )}
          {showBench && benchQ.data && (
            <div className="space-y-2 text-sm">
              {(benchQ.data.teams_ranked ?? []).map((t) => (
                <div key={t.rank} className="rounded-md border p-2">
                  <p className="font-medium">
                    #{t.rank} {t.team_name} — {n1(t.avg_score)} ({n1(t.avg_response_time)} mnt ·{" "}
                    {t.total_red_flags} red flag)
                  </p>
                  {(t.strengths ?? []).length > 0 && (
                    <p className="text-xs text-emerald-600">+ {t.strengths!.join(", ")}</p>
                  )}
                  {(t.weaknesses ?? []).length > 0 && (
                    <p className="text-xs text-red-600">- {t.weaknesses!.join(", ")}</p>
                  )}
                </div>
              ))}
              {benchQ.data.comparison_summary && (
                <p className="text-muted-foreground">{benchQ.data.comparison_summary}</p>
              )}
              {benchQ.data.gap_analysis && (
                <p className="text-xs text-muted-foreground">{benchQ.data.gap_analysis}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FrequencyFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Tampilkan:</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FREQ_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
