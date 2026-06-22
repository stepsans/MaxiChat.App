import { useMemo, useState } from "react";
import {
  useGetStorageUsage,
  useGetMyQuota,
  getGetStorageUsageQueryKey,
  getGetMyQuotaQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare,
  Bot,
  Flame,
  Users,
  ShieldAlert,
  HardDrive,
  Gauge,
  Layers,
  Coins,
  AlertTriangle,
  Frown,
  Clock,
  Inbox,
  GitBranch,
  Kanban,
  Trophy,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  MousePointerClick,
  Award,
  Package,
  HelpCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useLocation } from "wouter";
import { cn, formatBytes } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { FirstRunWizard } from "@/components/FirstRunWizard";
import SystemHealthStrip from "@/components/dashboard/SystemHealthStrip";
import DrillDownDialog from "@/components/dashboard/DrillDownDialog";
import {
  useDashboardSummary,
  useDashboardFlowMenu,
  useDashboardProducts,
  useDashboardTopQuestions,
  useDashboardRefresh,
  useDashboardAgentKpi,
  type DashboardRange,
  type DailyNarrative,
  type AgentKpiDimension,
} from "@/hooks/useDashboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  rangeForPreset,
  isLivePreset,
  PRESET_LABELS,
  type RangePreset,
} from "@/components/dashboard/dashboard-range";

// ── Formatters ───────────────────────────────────────────────────────────────
function fmtFrt(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function fmtRupiah(n: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
    notation: "compact",
  }).format(n);
}

// "HH:MM" in WIB (UTC+7) for the "diperbarui … WIB" label.
function wibTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(
    shifted.getUTCMinutes()
  ).padStart(2, "0")}`;
}

// AI Chat Report narrative panel (spec A.3 / 4.3). Rendered from the snapshot's
// cached narrative (no per-open AI cost).
function NarrativePanel({ narrative }: { narrative: DailyNarrative | null }) {
  if (!narrative || (!narrative.ringkasan && !(narrative.rekomendasi?.length))) return null;
  return (
    <Card data-testid="ai-chat-report-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          AI Chat Report
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {narrative.ringkasan && (
          <p className="text-sm text-foreground leading-relaxed">{narrative.ringkasan}</p>
        )}
        {(narrative.sorotan?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Sorotan</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {narrative.sorotan!.map((s, i) => (
                <li key={i} className="text-xs text-foreground">{s}</li>
              ))}
            </ul>
          </div>
        )}
        {(narrative.rekomendasi?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Rekomendasi</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {narrative.rekomendasi!.map((s, i) => (
                <li key={i} className="text-xs text-foreground">{s}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// A KPI card. When `metric` is provided the whole card becomes a button that
// opens the drill-down list (spec 5.1). Colours use theme tokens only.
function StatCard({
  title,
  value,
  icon: Icon,
  tone = "primary",
  sub,
  delta,
  onClick,
  testId,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  tone?: "primary" | "destructive" | "success" | "warning" | "muted";
  sub?: string;
  delta?: number;
  onClick?: () => void;
  testId?: string;
}) {
  const toneCls: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    destructive: "bg-destructive/10 text-destructive",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    muted: "bg-muted text-muted-foreground",
  };
  const body = (
    <CardContent className="p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            {title}
          </p>
          <p className="text-2xl font-bold mt-1 text-foreground tabular-nums">{value}</p>
          {(sub || delta != null) && (
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              {delta != null && delta !== 0 && (
                <span
                  className={cn(
                    "inline-flex items-center font-medium",
                    delta > 0 ? "text-success" : "text-destructive"
                  )}
                >
                  {delta > 0 ? (
                    <ArrowUp className="w-3 h-3" />
                  ) : (
                    <ArrowDown className="w-3 h-3" />
                  )}
                  {Math.abs(delta)}
                </span>
              )}
              {sub}
            </p>
          )}
        </div>
        <div className={cn("p-2 rounded-md flex-shrink-0", toneCls[tone])}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
    </CardContent>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className="rounded-xl border bg-card text-card-foreground shadow text-left transition-colors hover:bg-accent/40 cursor-pointer"
      >
        {body}
      </button>
    );
  }
  return <Card data-testid={testId}>{body}</Card>;
}

function QuotaBar({
  label,
  icon: Icon,
  used,
  limit,
  format,
  unit,
  testId,
  unlimited = false,
  warnPercent = 80,
  enforced = false,
}: {
  label: string;
  icon: React.ElementType;
  used: number;
  limit: number;
  format: (n: number) => string;
  unit?: string;
  testId: string;
  unlimited?: boolean;
  warnPercent?: number;
  enforced?: boolean;
}) {
  const hasLimit = !unlimited && limit > 0;
  const pct = hasLimit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const threshold = warnPercent > 0 && warnPercent <= 100 ? warnPercent : 80;
  const warn = hasLimit && pct >= threshold;
  const barColor = warn ? "bg-warning" : "bg-primary";
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          {label}
          {warn && (
            <AlertTriangle
              className="w-3.5 h-3.5 text-warning"
              data-testid={`${testId}-warning`}
            />
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {format(used)}
          {unlimited ? " / ∞" : hasLimit ? ` / ${format(limit)}` : ` / ∞`}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      {unlimited ? (
        <p className="text-[11px] mt-1 text-primary" data-testid={`${testId}-unlimited`}>
          Tidak terbatas
        </p>
      ) : (
        <>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", barColor)}
              style={{ width: `${hasLimit ? pct : 0}%` }}
            />
          </div>
          {hasLimit && (
            <p
              className={cn(
                "text-[11px] mt-1 tabular-nums",
                warn ? "text-warning" : "text-muted-foreground"
              )}
            >
              {pct}% terpakai
              {warn
                ? enforced
                  ? " — mendekati batas, unggahan baru akan diblokir"
                  : " — mendekati batas kuota"
                : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// A Tier-1 → Tier-2 module summary tile: a headline number + an arrow that
// navigates to the module's own (Tier-2) dashboard (spec A.0).
function ModuleCard({
  title,
  value,
  icon: Icon,
  href,
  testId,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  href: string;
  testId?: string;
}) {
  const [, navigate] = useLocation();
  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      data-testid={testId}
      className="rounded-xl border bg-card text-card-foreground shadow text-left w-full transition-colors hover:bg-accent/40 cursor-pointer"
    >
      <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-md bg-primary/10 text-primary flex-shrink-0">
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className="text-sm font-semibold text-foreground truncate">{value}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        </CardContent>
      </button>
  );
}

// "Menu chatbot ditekan" (spec A.4). Conditional: only meaningful when the owner
// has an active flow; otherwise nudge them to activate one.
function FlowMenuPanel({ range, enabled }: { range: DashboardRange; enabled: boolean }) {
  const { data, isLoading } = useDashboardFlowMenu(range, enabled);
  if (isLoading || !data) return null;
  const rows = data.rows;
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <Card data-testid="flow-menu-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MousePointerClick className="w-4 h-4 text-muted-foreground" />
          Menu Chatbot Ditekan
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!data.hasActiveFlow ? (
          <p className="text-sm text-muted-foreground">
            Belum ada Chatbot Flow aktif. Aktifkan flow dan nyalakan "Hitung di
            Dashboard" pada node pertanyaan untuk melihat menu yang paling sering ditekan.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Belum ada opsi yang ditekan pada periode ini.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={`${r.label}-${r.level}-${i}`} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground truncate">{r.label}</span>
                  <span className="tabular-nums text-muted-foreground">{r.count}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// "Produk paling diminati" (spec A.3) — bar ranking from AI analyses.
function ProductsPanel({ range, enabled }: { range: DashboardRange; enabled: boolean }) {
  const { data, isLoading } = useDashboardProducts(range, enabled);
  if (isLoading || !data || data.rows.length === 0) return null;
  const rows = data.rows;
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <Card data-testid="products-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Package className="w-4 h-4 text-muted-foreground" />
          Produk Paling Diminati
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={`${r.product}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground truncate">{r.product}</span>
                <span className="tabular-nums text-muted-foreground">{r.count}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// "Pertanyaan tersering" (spec A.3) — cached AI intent clustering. Range-
// independent (it's a scheduled snapshot), so it ignores the header range.
function TopQuestionsPanel({ enabled }: { enabled: boolean }) {
  const { data, isLoading } = useDashboardTopQuestions(enabled);
  if (isLoading || !data || data.questions.length === 0) return null;
  const rows = data.questions;
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <Card data-testid="top-questions-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-muted-foreground" />
          Pertanyaan Tersering
          <span className="ml-auto text-[11px] font-normal text-muted-foreground">
            {data.windowDays} hari terakhir
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={`${r.intent}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground truncate">{r.intent}</span>
                <span className="tabular-nums text-muted-foreground">{r.count}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Papan KPI Agent (spec 5.4) — dimension dropdown + ranked leaderboard sourced
// from the latest ACR job's per-agent scores.
const AGENT_KPI_DIMENSIONS: { key: AgentKpiDimension; label: string; ai: boolean; unit?: string }[] = [
  { key: "kpi", label: "Nilai KPI (gabungan)", ai: false },
  { key: "speed", label: "Kecepatan Balas", ai: false, unit: "mnt" },
  { key: "lang", label: "Kualitas Bahasa", ai: true },
  { key: "accuracy", label: "Ketepatan Jawaban", ai: true },
  { key: "complaint", label: "Handling Komplain", ai: true },
  { key: "unanswered", label: "Chat Tak Terjawab", ai: false },
];

function fmtKpiValue(dim: AgentKpiDimension, v: number | null): string {
  if (v == null) return "—";
  if (dim === "speed") return `${v.toFixed(1)} mnt`;
  if (dim === "unanswered") return `${v}`;
  return `${Math.round(v)}`;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function AgentKpiPanel({ enabled }: { enabled: boolean }) {
  const [dimension, setDimension] = useState<AgentKpiDimension>("kpi");
  const { data, isLoading } = useDashboardAgentKpi(dimension, enabled);
  const meta = AGENT_KPI_DIMENSIONS.find((d) => d.key === dimension)!;
  const rows = data?.rows ?? [];
  const maxVal = rows.reduce((m, r) => Math.max(m, r.value ?? 0), 0) || 1;

  return (
    <Card data-testid="agent-kpi-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="w-4 h-4 text-muted-foreground" />
            Papan KPI Agent
          </CardTitle>
          <Select value={dimension} onValueChange={(v) => setDimension(v as AgentKpiDimension)}>
            <SelectTrigger className="h-8 w-[200px] text-xs" data-testid="agent-kpi-dimension">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_KPI_DIMENSIONS.map((d) => (
                <SelectItem key={d.key} value={d.key} className="text-xs">
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {meta.ai && (
          <Badge variant="outline" className="mb-3 text-[10px] gap-1">
            <Sparkles className="w-3 h-3" />
            dinilai AI
          </Badge>
        )}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Memuat…</p>
        ) : !data?.jobId ? (
          <p className="text-sm text-muted-foreground">
            Belum ada data KPI agent. Jalankan AI Chat Report terlebih dahulu.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada agent yang dinilai.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={r.agentUserId} className="flex items-center gap-3">
                <span className="w-5 text-xs font-semibold tabular-nums text-muted-foreground text-right">
                  {i + 1}
                </span>
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                  {initials(r.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground truncate">{r.name}</span>
                    <span className="tabular-nums text-foreground font-semibold ml-2">
                      {r.insufficientData ? "—" : fmtKpiValue(dimension, r.value)}
                    </span>
                  </div>
                  <div className="h-1.5 mt-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(((r.value ?? 0) / maxVal) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PRESETS: RangePreset[] = ["today", "7d", "month"];

export default function Dashboard() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.dashboard.canView;

  const [preset, setPreset] = useState<RangePreset>("today");
  const range = useMemo(() => rangeForPreset(preset), [preset]);
  const live = isLivePreset(preset);

  const [drill, setDrill] = useState<{ metric: string; title: string } | null>(null);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(range, live);
  const refresh = useDashboardRefresh();
  const { data: storage, isLoading: storageLoading } = useGetStorageUsage({
    query: { queryKey: getGetStorageUsageQueryKey(), enabled: canView },
  });
  const { data: quota, isLoading: quotaLoading } = useGetMyQuota({
    query: { queryKey: getGetMyQuotaQueryKey(), enabled: canView },
  });

  // View-role: owners can preview the CS operational layout. CS users are pinned
  // to "cs" (owner-only signals come back null from the API anyway).
  const apiRole = summary?.role ?? "cs";
  const [viewRole, setViewRole] = useState<"owner" | "cs" | null>(null);
  const role = viewRole ?? apiRole;
  const isOwner = apiRole === "owner";

  // Route is unguarded — self-guard so a user without dashboard.view who
  // navigates here directly gets a clear message instead of 403-driven blanks.
  if (!permLoading && !menus.dashboard.canView) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Anda tidak memiliki izin untuk melihat Dashboard.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const ls = summary?.lead_status ?? { lead: 0, not_lead: 0, unknown: 0 };
  const openDrill = (metric: string, title: string) => setDrill({ metric, title });

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-foreground">Dashboard</h1>
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
            {summary?.from_snapshot && summary.updated_at
              ? `Diperbarui ${wibTime(summary.updated_at)} WIB`
              : live
              ? "Pantauan langsung"
              : "Mode laporan"}
            {isOwner && summary?.from_snapshot && (
              <button
                type="button"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                data-testid="dashboard-refresh"
                className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3 h-3", refresh.isPending && "animate-spin")} />
                Refresh
              </button>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Owner can preview the CS view */}
          {isOwner && (
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              {(["owner", "cs"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setViewRole(r)}
                  data-testid={`role-toggle-${r}`}
                  className={cn(
                    "px-2.5 py-1 font-medium transition-colors",
                    role === r
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-muted-foreground hover:bg-accent/40"
                  )}
                >
                  {r === "owner" ? "Owner" : "CS"}
                </button>
              ))}
            </div>
          )}
          {/* Date range presets */}
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                data-testid={`range-preset-${p}`}
                className={cn(
                  "px-2.5 py-1 font-medium transition-colors",
                  preset === p
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent/40"
                )}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* System Health strip (spec A.9) — reliability signals at the very top. */}
        <SystemHealthStrip />

        {/* First-run wizard + onboarding (hide themselves once healthy). */}
        <FirstRunWizard />
        <OnboardingChecklist />

        {/* KPI grid — role-based (spec A.2). */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {summaryLoading ? (
            Array(5)
              .fill(0)
              .map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)
          ) : (
            <>
              <StatCard
                title="Percakapan"
                value={summary?.percakapan.count ?? 0}
                icon={MessageSquare}
                tone="primary"
                delta={summary?.percakapan.delta}
                sub="vs periode sebelumnya"
                onClick={() => openDrill("conversations", "Percakapan")}
                testId="kpi-percakapan"
              />

              <StatCard
                title="Belum Dibalas"
                value={summary?.belum_dibalas ?? 0}
                icon={Inbox}
                tone="warning"
                onClick={() => openDrill("waiting", "Belum Dibalas")}
                testId="kpi-belum-dibalas"
              />

              {summary?.tidak_puas != null && (
                <StatCard
                  title="Customer Tidak Puas"
                  value={summary.tidak_puas}
                  icon={Frown}
                  tone="destructive"
                  testId="kpi-tidak-puas"
                />
              )}

              {role === "owner" ? (
                <>
                  {summary?.lead_panas != null && (
                    <StatCard
                      title="Lead Panas"
                      value={summary.lead_panas}
                      icon={Flame}
                      tone="primary"
                      sub="skor ≥ 80"
                      testId="kpi-lead-panas"
                    />
                  )}
                  <StatCard
                    title="Ditangani AI"
                    value={summary?.ai_handled_percent != null ? `${summary.ai_handled_percent}%` : "—"}
                    icon={Bot}
                    tone="success"
                    testId="kpi-ai-handled"
                  />
                  {summary?.won != null && (
                    <StatCard
                      title="Won"
                      value={summary.won.count}
                      icon={Award}
                      tone="success"
                      sub={fmtRupiah(summary.won.value)}
                      testId="kpi-won"
                    />
                  )}
                </>
              ) : (
                <>
                  <StatCard
                    title="Avg Balas Pertama"
                    value={fmtFrt(summary?.avg_frt_seconds ?? null)}
                    icon={Clock}
                    tone="primary"
                    testId="kpi-frt"
                  />
                  <StatCard
                    title="Chat Aktif Saya"
                    value={summary?.my_active ?? 0}
                    icon={Users}
                    tone="muted"
                    onClick={() => openDrill("my_active", "Chat Aktif Saya")}
                    testId="kpi-my-active"
                  />
                </>
              )}
            </>
          )}
        </div>

        {/* AI Chat Report narrative (spec A.3) — owner-facing, from snapshot. */}
        {role === "owner" && <NarrativePanel narrative={summary?.narrative ?? null} />}

        {/* Lead Status (spec A.7) — each row drills into its chat list. */}
        <Card data-testid="lead-status-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Status Lead</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              {([
                { key: "lead", label: "Leads", value: ls.lead, tone: "success" as const },
                { key: "not_lead", label: "Not Leads", value: ls.not_lead, tone: "muted" as const },
                { key: "unknown", label: "Unknown", value: ls.unknown, tone: "muted" as const },
              ]).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => openDrill(row.key, row.label)}
                  data-testid={`lead-status-${row.key}`}
                  className="text-left rounded-md border border-border p-3 transition-colors hover:bg-accent/40"
                >
                  <p className="text-2xl font-bold tabular-nums text-foreground">{row.value}</p>
                  <p
                    className={cn(
                      "text-xs font-medium mt-0.5",
                      row.tone === "success" ? "text-success" : "text-muted-foreground"
                    )}
                  >
                    {row.label}
                  </p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Produk paling diminati (spec A.3) + Pertanyaan tersering (spec A.3) +
            Menu chatbot ditekan (spec A.4). */}
        <ProductsPanel range={range} enabled={canView} />
        <TopQuestionsPanel enabled={canView} />
        <FlowMenuPanel range={range} enabled={canView} />

        {/* Papan KPI Agent (spec 5.4). */}
        <AgentKpiPanel enabled={canView} />

        {/* Module summary tiles → Tier-2 dashboards (spec A.0). */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Modul
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <ModuleCard
              title="Chat"
              value={`${summary?.percakapan.count ?? 0} percakapan`}
              icon={MessageSquare}
              href="/chat-insights"
              testId="module-chat"
            />
            <ModuleCard
              title="AI Pipeline"
              value={`${summary?.lead_panas ?? 0} lead panas`}
              icon={GitBranch}
              href="/ai-pipeline"
              testId="module-ai-pipeline"
            />
            <ModuleCard
              title="WorkBoard"
              value="Buka papan"
              icon={Kanban}
              href="/workboard"
              testId="module-workboard"
            />
            <ModuleCard
              title="KPI Agent"
              value="Lihat laporan"
              icon={Trophy}
              href="/analytics?tab=ai"
              testId="module-agent-kpi"
            />
          </div>
        </div>

        {/* Data Usage */}
        <Card data-testid="storage-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-muted-foreground" />
              Penggunaan Data Chat
            </CardTitle>
          </CardHeader>
          <CardContent>
            {storageLoading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-bytes">
                    {formatBytes(storage?.estimatedBytes)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Total data tersimpan</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-chats">
                    {storage?.chatCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Chat</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-messages">
                    {storage?.messageCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Pesan</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quota Usage — owner-facing limits. */}
        <Card data-testid="quota-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Gauge className="w-4 h-4 text-muted-foreground" />
              Penggunaan Kuota
            </CardTitle>
          </CardHeader>
          <CardContent>
            {quotaLoading || !quota ? (
              <Skeleton className="h-32 rounded-lg" />
            ) : (
              <div className="space-y-4">
                <QuotaBar
                  label="Penyimpanan media"
                  icon={HardDrive}
                  used={quota.usage.mediaStorageBytes}
                  limit={quota.storageLimit}
                  format={(n) => formatBytes(n)}
                  testId="quota-storage"
                  unlimited={quota.unlimited}
                  warnPercent={quota.storageWarnPercent ?? 80}
                  enforced={quota.storageEnforcementEnabled ?? false}
                />
                <QuotaBar
                  label="Pengguna"
                  icon={Users}
                  used={quota.usage.childUserCount}
                  limit={quota.userLimit}
                  format={(n) => `${n}`}
                  unit="user"
                  testId="quota-users"
                  unlimited={quota.unlimited}
                />
                <QuotaBar
                  label="Channel"
                  icon={Layers}
                  used={quota.usage.channelCount}
                  limit={quota.channelLimit}
                  format={(n) => `${n}`}
                  unit="channel"
                  testId="quota-channels"
                  unlimited={quota.unlimited}
                />
                <QuotaBar
                  label="Token AI"
                  icon={Coins}
                  used={quota.usage.tokenUsage}
                  limit={quota.tokenLimit}
                  format={(n) => n.toLocaleString("id-ID")}
                  unit="token"
                  testId="quota-tokens"
                  unlimited={quota.unlimited}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Drill-down dialog (spec 5.1). */}
      <DrillDownDialog
        metric={drill?.metric ?? null}
        title={drill?.title ?? ""}
        range={range}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}
