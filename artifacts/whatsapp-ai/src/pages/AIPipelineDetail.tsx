import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  useGetAiPipeline,
  useListAiPipelines,
  useGetAiPipelineDashboardStats,
  useListAiPipelineAnalyses,
  useListAiPipelineEntries,
  useGetAiPipelineEntry,
  useGetAiPipelineAnalysis,
  useDoNotFollowupAiPipelineEntry,
  useUpdateAiPipelineEntry,
  useRunAiPipelineNow,
  useToggleAiPipeline,
  useUpdateAiPipeline,
  useDeleteAiPipeline,
  useListChannels,
  useListCustomerLabels,
  getGetAiPipelineQueryKey,
  getGetAiPipelineEntryQueryKey,
  getGetAiPipelineAnalysisQueryKey,
  getListAiPipelinesQueryKey,
  getListAiPipelineEntriesQueryKey,
  getGetAiPipelineDashboardStatsQueryKey,
  type AiPipeline,
  type AiPipelineAnalysis,
  type AiPipelineEntry,
  type Channel,
  type CustomerLabel,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Play,
  Power,
  Pencil,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Target,
  Zap,
  TrendingUp,
  Users,
  X,
  Search,
  Ban,
  MessageSquare,
  Eye,
  Save,
  Check,
  GripVertical,
  Snowflake,
  LayoutGrid,
  BarChart3,
  Settings2,
  Phone,
  Copy,
  ExternalLink,
  Image,
  Upload,
  ZoomIn,
  Download,
  Smartphone,
  ThumbsUp,
  Brain,
  Lightbulb,
  Calendar,
  Send,
  Sparkles,
  FlaskConical,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
} from "recharts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dt: string | null | undefined): string {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelative(dt: string | null | undefined): string {
  if (!dt) return "—";
  const diffMs = Date.now() - new Date(dt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins} mnt lalu`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} jam lalu`;
  return `${Math.floor(diffHours / 24)} hari lalu`;
}

function scoreColor(val: number): string {
  if (val <= 40) return "#EF4444";
  if (val <= 60) return "#F59E0B";
  if (val <= 79) return "#3B82F6";
  return "#10B981";
}

function scoreBadge(val: number) {
  if (val <= 40) return <Badge className="bg-red-100 text-red-700 border-red-200">{val} Dingin</Badge>;
  if (val <= 60) return <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">{val} Hangat</Badge>;
  if (val <= 79) return <Badge className="bg-blue-100 text-blue-700 border-blue-200">{val} Potensial</Badge>;
  return <Badge className="bg-green-100 text-green-700 border-green-200">{val} Panas</Badge>;
}

function avatarColor(name: string): string {
  const palette = ["#6366f1", "#8b5cf6", "#ec4899", "#14b8a6", "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#f97316", "#0ea5e9"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
}

function scoreLabel(val: number): string {
  if (val <= 40) return "Dingin";
  if (val <= 60) return "Hangat";
  if (val <= 79) return "Potensial";
  return "Panas";
}

function ScoreGauge({ score }: { score: number }) {
  const radius = 42;
  const stroke = 9;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dashOffset = circumference * (1 - pct);
  const color = scoreColor(score);
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="108" height="108" viewBox="0 0 108 108">
        <circle cx="54" cy="54" r={radius} fill="none" stroke="currentColor" className="text-muted/40" strokeWidth={stroke} />
        <circle cx="54" cy="54" r={radius} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          strokeLinecap="round" transform="rotate(-90 54 54)"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
        <text x="54" y="51" textAnchor="middle" fill={color} fontSize="24" fontWeight="bold" fontFamily="inherit">{score}</text>
        <text x="54" y="66" textAnchor="middle" fill="currentColor" fontSize="11" className="fill-muted-foreground" fontFamily="inherit">/100</text>
      </svg>
      <span className="text-xs font-semibold" style={{ color }}>{scoreLabel(score)}</span>
    </div>
  );
}

type EntryModalTab = "detail" | "signals" | "conversation" | "followup";

// ─── Kanban column definitions ─────────────────────────────────────────────────

const KANBAN_COLUMNS = [
  { id: "new",             label: "Baru",               color: "#6366f1", isTerminal: false },
  { id: "in_progress",     label: "Diproses",            color: "#3b82f6", isTerminal: false },
  { id: "followup_sent",   label: "Follow-up Terkirim",  color: "#f59e0b", isTerminal: false },
  { id: "replied",         label: "Dibalas",             color: "#14b8a6", isTerminal: false },
  { id: "closed_won",      label: "Menang",              color: "#10b981", isTerminal: true  },
  { id: "closed_lost",     label: "Kalah",               color: "#ef4444", isTerminal: true  },
  { id: "do_not_followup", label: "Jangan Follow-up",   color: "#6b7280", isTerminal: true  },
] as const;

type EntryStatus = (typeof KANBAN_COLUMNS)[number]["id"];

// ─── Dashboard Tab ─────────────────────────────────────────────────────────────

function MetricCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-bold tabular-nums truncate", accent)}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
      <div className={cn("p-3 rounded-lg shrink-0", color)}>
        <Icon className="h-5 w-5 text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground leading-tight">{label}</p>
      </div>
    </div>
  );
}

function DashboardTab({ pipelineId }: { pipelineId: number }) {
  const { data: stats } = useGetAiPipelineDashboardStats(pipelineId, {
    query: { queryKey: getGetAiPipelineDashboardStatsQueryKey(pipelineId) },
  });
  const { data: entriesData } = useListAiPipelineEntries(pipelineId, { pageSize: 500 });
  const entries = entriesData?.data ?? [];

  // Compute pipeline-level metrics from entries
  const terminalStatuses = new Set<string>(KANBAN_COLUMNS.filter((c) => c.isTerminal).map((c) => c.id));
  const activeEntries = entries.filter((e) => !terminalStatuses.has(e.status));
  const wonEntries = entries.filter((e) => e.status === "closed_won");
  const lostEntries = entries.filter((e) => e.status === "closed_lost");

  const totalPipelineValue = activeEntries.reduce((s, e) => s + (e.estimatedValue ?? 0), 0);
  const wonValue = wonEntries.reduce((s, e) => s + (e.estimatedValue ?? 0), 0);
  const avgScore = entries.length > 0
    ? Math.round(entries.reduce((s, e) => s + e.currentScore, 0) / entries.length)
    : 0;
  const conversionRate = stats && stats.today.analyzed > 0
    ? Math.round((stats.today.enteredPipeline / stats.today.analyzed) * 100)
    : null;
  const totalFollowups = entries.reduce((s, e) => s + (e.followupCount ?? 0), 0);
  const repliedCount = entries.filter((e) => e.status === "replied").length;

  // Per-status breakdown for chart
  const statusBreakdown = KANBAN_COLUMNS.map((col) => {
    const colEntries = entries.filter((e) => e.status === col.id);
    return {
      name: col.label,
      color: col.color,
      count: colEntries.length,
      value: colEntries.reduce((s, e) => s + (e.estimatedValue ?? 0), 0),
      avgScore: colEntries.length > 0
        ? Math.round(colEntries.reduce((s, e) => s + e.currentScore, 0) / colEntries.length)
        : 0,
    };
  }).filter((s) => s.count > 0);

  const totalEntries = entries.length;

  const scoreData = stats?.scoreDistribution ?? [];

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array(8).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Aktivitas Hari Ini ── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Aktivitas Hari Ini</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard label="Dianalisa AI" value={stats.today.analyzed} icon={BrainCircuit} color="bg-purple-500" />
          <StatCard label="Masuk Pipeline" value={stats.today.enteredPipeline} icon={Target} color="bg-blue-500" />
          <StatCard label="Follow-up Dikirim" value={stats.today.followupsSent} icon={MessageSquare} color="bg-orange-500" />
        </div>
      </div>

      {/* ── Metrik Pipeline ── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Metrik Pipeline</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard
            label="Total nilai pipeline aktif"
            value={totalPipelineValue > 0 ? formatRupiah(totalPipelineValue) : "—"}
            hint={`${activeEntries.length} kontak aktif`}
            accent="text-primary"
          />
          <MetricCard
            label="Nilai deal won"
            value={wonValue > 0 ? formatRupiah(wonValue) : "—"}
            hint={`${wonEntries.length} deal closed won`}
            accent="text-green-600"
          />
          <MetricCard
            label="Rata-rata skor AI"
            value={entries.length > 0 ? `${avgScore} / 100` : "—"}
            hint={`${totalEntries} kontak total`}
            accent={avgScore > 0 ? `text-[${scoreColor(avgScore)}]` : undefined}
          />
          <MetricCard
            label="Conversion rate (hari ini)"
            value={conversionRate !== null ? `${conversionRate}%` : "—"}
            hint={stats.today.analyzed > 0 ? `${stats.today.enteredPipeline} dari ${stats.today.analyzed} analisa` : "Belum ada analisa hari ini"}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <MetricCard
            label="Kontak aktif di pipeline"
            value={String(activeEntries.length)}
            hint={`${totalEntries} total kontak`}
          />
          <MetricCard
            label="Total follow-up terkirim"
            value={String(totalFollowups)}
            hint={`${repliedCount} kontak membalas`}
          />
          <MetricCard
            label="Kontak closed won"
            value={String(wonEntries.length)}
            hint={wonEntries.length > 0 && totalEntries > 0 ? `${Math.round((wonEntries.length / totalEntries) * 100)}% dari total` : undefined}
            accent="text-green-600"
          />
          <MetricCard
            label="Kontak closed lost / stop"
            value={String(lostEntries.length + entries.filter((e) => e.status === "do_not_followup").length)}
            hint={`${lostEntries.length} lost · ${entries.filter((e) => e.status === "do_not_followup").length} stop`}
            accent="text-rose-600"
          />
        </div>
      </div>

      {/* ── Nilai per Status (Bar Chart) ── */}
      {statusBreakdown.length > 0 && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Nilai & Jumlah per Status</h3>
            <p className="text-xs text-muted-foreground">Estimasi nilai pipeline (batang) dan jumlah kontak (angka) per status.</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusBreakdown} margin={{ top: 4, right: 4, left: 8, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10 }}
                  className="fill-muted-foreground"
                  angle={-20}
                  textAnchor="end"
                  height={40}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  className="fill-muted-foreground"
                  tickFormatter={(v) =>
                    new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v))
                  }
                />
                <Tooltip
                  formatter={(v: number) => [formatRupiah(v), "Estimasi Nilai"]}
                  labelStyle={{ fontSize: 11, fontWeight: 600 }}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {statusBreakdown.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Distribusi Kontak per Status ── */}
      {statusBreakdown.length > 0 && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Distribusi Kontak per Status</h3>
          <div className="space-y-2">
            {statusBreakdown.map((s) => {
              const pct = totalEntries > 0 ? Math.round((s.count / totalEntries) * 100) : 0;
              return (
                <div key={s.name} className="flex items-center gap-3">
                  <span className="text-xs w-28 truncate shrink-0 text-muted-foreground">{s.name}</span>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: s.color }} />
                  </div>
                  <span className="text-xs font-mono w-12 text-right shrink-0 text-muted-foreground">{s.count} kontak</span>
                  <span className="text-xs font-mono w-8 text-right shrink-0">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Distribusi Skor AI (7 Hari Terakhir) ── */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Distribusi Skor AI</h3>
          <p className="text-xs text-muted-foreground">Hasil analisa dalam 7 hari terakhir berdasarkan tingkat skor.</p>
        </div>
        {scoreData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Belum ada data analisa</p>
        ) : (
          <div className="space-y-2">
            {scoreData.map((d) => {
              const total = scoreData.reduce((s, x) => s + (x.count ?? 0), 0);
              const pct = total > 0 ? Math.round(((d.count ?? 0) / total) * 100) : 0;
              return (
                <div key={d.range} className="flex items-center gap-3">
                  <span className="text-xs w-24 text-right shrink-0 text-muted-foreground">{d.range}</span>
                  <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: d.color ?? "#888" }} />
                  </div>
                  <span className="text-xs w-8 text-right font-medium">{d.count}</span>
                  <span className="text-xs w-8 text-right text-muted-foreground">{pct}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Analisa Terbaru (enhanced) ── */}
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <h3 className="text-sm font-semibold">Analisa Terbaru</h3>
        {stats.recentAnalyses.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Belum ada analisa</p>
        ) : (
          <div className="divide-y">
            {stats.recentAnalyses.slice(0, 10).map((a) => (
              <div key={a.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{a.contactName ?? a.contactPhone}</p>
                    {a.enteredPipeline && (
                      <span className="shrink-0 text-[10px] text-green-700 bg-green-100 border border-green-200 px-1.5 py-0.5 rounded-full">
                        Pipeline
                      </span>
                    )}
                  </div>
                  {a.recommendation ? (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{a.recommendation}</p>
                  ) : null}
                  <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelative(a.createdAt)}</p>
                </div>
                <div className="shrink-0">
                  {scoreBadge(a.score)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Timeline Jadwal Analisa ── */}
      {stats.cutoffTimeline.length > 0 && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Riwayat Jadwal Analisa</h3>
          <div className="space-y-2">
            {stats.cutoffTimeline.slice(0, 10).map((c, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={cn(
                  "w-2.5 h-2.5 rounded-full shrink-0",
                  c.status === "completed" ? "bg-green-500" :
                  c.status === "failed" ? "bg-red-500" :
                  c.status === "running" ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/30"
                )} />
                <span className="text-xs text-muted-foreground flex-1">{formatDate(c.scheduledTime)}</span>
                <span className={cn("text-xs font-medium capitalize px-2 py-0.5 rounded-full border", {
                  "text-green-700 bg-green-50 border-green-200": c.status === "completed",
                  "text-red-700 bg-red-50 border-red-200": c.status === "failed",
                  "text-blue-700 bg-blue-50 border-blue-200": c.status === "running",
                  "text-muted-foreground border-border bg-muted/30": c.status === "pending",
                })}>
                  {c.status === "completed" ? "Selesai" :
                   c.status === "failed" ? "Gagal" :
                   c.status === "running" ? "Berjalan" : "Menunggu"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analysis Tab ──────────────────────────────────────────────────────────────

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value} / {max}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, (value / max)) * 100}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function AnalysisDrawer({ analysis, onClose }: { analysis: AiPipelineAnalysis | null; onClose: () => void }) {
  if (!analysis) return null;
  const breakdown = analysis.scoreBreakdown as Record<string, number> | null;
  return (
    <Sheet open={!!analysis} onOpenChange={() => onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader><SheetTitle>Hasil Analisa AI</SheetTitle></SheetHeader>
        <div className="mt-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{analysis.contactName ?? analysis.contactPhone}</p>
              <p className="text-xs text-muted-foreground">{analysis.contactPhone}</p>
            </div>
            {scoreBadge(analysis.score)}
          </div>
          {breakdown && (
            <div className="space-y-3 rounded-xl border p-4">
              <h4 className="text-sm font-semibold">Breakdown Skor</h4>
              <ScoreBar label="Sinyal Beli" value={breakdown.buying_signal ?? 0} max={30} color="#6366f1" />
              <ScoreBar label="Urgensi" value={breakdown.urgency ?? 0} max={20} color="#f59e0b" />
              <ScoreBar label="Engagement" value={breakdown.engagement ?? 0} max={20} color="#3b82f6" />
              <ScoreBar label="Komitmen" value={breakdown.commitment ?? 0} max={15} color="#10b981" />
              <ScoreBar label="Kesesuaian Produk" value={breakdown.product_fit ?? 0} max={10} color="#8b5cf6" />
              <div className="flex justify-between text-xs pt-2 border-t">
                <span className="text-muted-foreground">Penyesuaian Hambatan</span>
                <span className={cn("font-medium", (breakdown.barrier_adjustment ?? 0) < 0 ? "text-red-500" : "text-green-500")}>
                  {breakdown.barrier_adjustment > 0 ? "+" : ""}{breakdown.barrier_adjustment ?? 0}
                </span>
              </div>
            </div>
          )}
          {analysis.scoreReason && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Alasan Skor</p>
              <p className="text-sm">{analysis.scoreReason}</p>
            </div>
          )}
          {analysis.recommendation && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Rekomendasi</p>
              <p className="text-sm">{analysis.recommendation}</p>
            </div>
          )}
          {analysis.productInterest && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Produk Diminati</p>
              <p className="text-sm">{analysis.productInterest}</p>
            </div>
          )}
          {analysis.aiNotes && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Catatan AI</p>
              <p className="text-sm">{analysis.aiNotes}</p>
            </div>
          )}
          <div className="text-xs text-muted-foreground border-t pt-3 space-y-1">
            <p>Cutoff: {formatDate(analysis.cutoffDatetime)}</p>
            <p>Dibuat: {formatDate(analysis.createdAt)}</p>
            {analysis.enteredPipeline && (
              <p className="text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Masuk pipeline
              </p>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

type ScoreTier = "all" | "panas" | "potensial" | "hangat" | "dingin";
type PipelineFilter = "all" | "masuk" | "tidak";

function AnalysesTab({ pipelineId }: { pipelineId: number }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [scoreTier, setScoreTier] = useState<ScoreTier>("all");
  const [pipelineFilter, setPipelineFilter] = useState<PipelineFilter>("all");
  const [sortBy, setSortBy] = useState<"score" | "time">("time");
  const [selectedAnalysis, setSelectedAnalysis] = useState<AiPipelineAnalysis | null>(null);
  const { data, isLoading } = useListAiPipelineAnalyses(pipelineId, { page, pageSize: 50 });

  const allAnalyses = data?.data ?? [];

  // Stats
  const totalCount = data?.total ?? 0;
  const enteredCount = allAnalyses.filter((a) => a.enteredPipeline).length;
  const avgScore = allAnalyses.length > 0
    ? Math.round(allAnalyses.reduce((s, a) => s + a.score, 0) / allAnalyses.length)
    : 0;

  const filtered = allAnalyses
    .filter((a) => {
      if (search && !a.contactPhone.includes(search) && !(a.contactName ?? "").toLowerCase().includes(search.toLowerCase())) return false;
      if (scoreTier === "panas" && a.score <= 79) return false;
      if (scoreTier === "potensial" && (a.score <= 60 || a.score > 79)) return false;
      if (scoreTier === "hangat" && (a.score <= 40 || a.score > 60)) return false;
      if (scoreTier === "dingin" && a.score > 40) return false;
      if (pipelineFilter === "masuk" && !a.enteredPipeline) return false;
      if (pipelineFilter === "tidak" && a.enteredPipeline) return false;
      return true;
    })
    .sort((a, b) => sortBy === "score" ? b.score - a.score : 0);

  const TIER_LABELS: Array<{ id: ScoreTier; label: string; color: string }> = [
    { id: "all", label: "Semua Skor", color: "" },
    { id: "panas", label: "Panas (>79)", color: "#10B981" },
    { id: "potensial", label: "Potensial (61–79)", color: "#3B82F6" },
    { id: "hangat", label: "Hangat (41–60)", color: "#F59E0B" },
    { id: "dingin", label: "Dingin (≤40)", color: "#EF4444" },
  ];

  return (
    <div className="space-y-4">

      {/* Stats header */}
      {allAnalyses.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-xl font-bold">{totalCount}</p>
            <p className="text-xs text-muted-foreground">Total Analisa</p>
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-xl font-bold text-green-600">{enteredCount}</p>
            <p className="text-xs text-muted-foreground">Masuk Pipeline</p>
            {enteredCount > 0 && allAnalyses.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {Math.round((enteredCount / allAnalyses.length) * 100)}% conversion
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-card p-3 text-center">
            <p className="text-xl font-bold" style={{ color: avgScore > 0 ? scoreColor(avgScore) : undefined }}>
              {avgScore > 0 ? `${avgScore}` : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Rata-rata Skor</p>
            {avgScore > 0 && (
              <p className="text-[10px] text-muted-foreground">{scoreLabel(avgScore)}</p>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Cari nomor/nama..." className="pl-9 h-8 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {/* Score tier filter */}
        <div className="flex items-center gap-1 flex-wrap">
          {TIER_LABELS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setScoreTier(t.id)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                scoreTier === t.id
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
              style={scoreTier === t.id && t.color ? { backgroundColor: t.color, borderColor: t.color, color: "#fff" } : {}}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Pipeline filter */}
        <div className="flex items-center gap-1">
          {(["all", "masuk", "tidak"] as PipelineFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setPipelineFilter(f)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                pipelineFilter === f
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
            >
              {f === "all" ? "Semua" : f === "masuk" ? "✓ Pipeline" : "Tidak masuk"}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-muted-foreground">Urut:</span>
          {(["time", "score"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSortBy(s)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                sortBy === s
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
            >
              {s === "time" ? "Terbaru" : "Skor ↓"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <BrainCircuit className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Tidak ada analisa dengan filter ini</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Kontak</th>
                  <th className="text-center px-3 py-2.5 text-xs font-medium text-muted-foreground w-16">Skor</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Rekomendasi AI</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Produk</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell w-24">Status</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell w-24">Waktu</th>
                  <th className="px-3 py-2.5 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setSelectedAnalysis(a)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-sm">{a.contactName ?? a.contactPhone}</p>
                      {a.contactName && <p className="text-xs text-muted-foreground">{a.contactPhone}</p>}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <div className="inline-flex flex-col items-center gap-0.5">
                        <span
                          className="inline-flex items-center justify-center w-9 h-9 rounded-full text-white text-sm font-bold"
                          style={{ backgroundColor: scoreColor(a.score) }}
                        >
                          {a.score}
                        </span>
                        <span className="text-[9px] text-muted-foreground">{scoreLabel(a.score)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 hidden lg:table-cell max-w-[200px]">
                      <p className="text-xs text-muted-foreground truncate">
                        {a.recommendation ? a.recommendation.slice(0, 80) + (a.recommendation.length > 80 ? "…" : "") : "—"}
                      </p>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell max-w-[120px]">
                      <p className="text-xs text-muted-foreground truncate">{a.productInterest ?? "—"}</p>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell">
                      {a.enteredPipeline ? (
                        <span className="text-[11px] text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full flex items-center gap-1 w-fit">
                          <CheckCircle2 className="h-3 w-3" />Pipeline
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">Tidak masuk</span>
                      )}
                    </td>
                    <td className="px-3 py-3 hidden sm:table-cell text-xs text-muted-foreground">{formatRelative(a.createdAt)}</td>
                    <td className="px-3 py-3">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); setSelectedAnalysis(a); }}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && data.total > 50 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{data.total} total · menampilkan {filtered.length}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span>{page} / {Math.ceil(data.total / 50)}</span>
                <Button size="sm" variant="outline" disabled={page >= Math.ceil(data.total / 50)} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <AnalysisDrawer analysis={selectedAnalysis} onClose={() => setSelectedAnalysis(null)} />
    </div>
  );
}

// ─── Entry Modal (4 tabs) ──────────────────────────────────────────────────────

function EntryModal({ pipelineId, entryId, onClose }: { pipelineId: number; entryId: number | null; onClose: () => void }) {
  const { data: entry } = useGetAiPipelineEntry(pipelineId, entryId ?? 0, {
    query: { queryKey: getGetAiPipelineEntryQueryKey(pipelineId, entryId ?? 0), enabled: entryId != null },
  });

  const analysisId = entry?.analysisId ?? 0;
  const { data: analysis } = useGetAiPipelineAnalysis(pipelineId, analysisId, {
    query: {
      queryKey: getGetAiPipelineAnalysisQueryKey(pipelineId, analysisId),
      enabled: entryId != null && analysisId > 0,
    },
  });
  const qc = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<EntryModalTab>("detail");
  const [template, setTemplate] = useState("");
  const templateInit = useRef(false);
  const [editingStatus, setEditingStatus] = useState(false);

  const { mutate: doNotFollowup, isPending: blocking } = useDoNotFollowupAiPipelineEntry({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAiPipelineEntriesQueryKey(pipelineId) });
        toast({ title: "Follow-up dihentikan untuk kontak ini." });
        onClose();
      },
    },
  });

  const { mutate: changeStatus, isPending: changingStatus } = useUpdateAiPipelineEntry({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAiPipelineEntriesQueryKey(pipelineId) });
        qc.invalidateQueries({ queryKey: getGetAiPipelineEntryQueryKey(pipelineId, entryId ?? 0) });
        toast({ title: "Status berhasil diubah." });
        setEditingStatus(false);
      },
    },
  });

  const lastLog = entry?.followupLogs?.slice(-1)[0] ?? null;
  const aiTemplate = lastLog?.messageSent ?? null;

  useEffect(() => {
    if (!templateInit.current && aiTemplate) {
      templateInit.current = true;
      setTemplate(aiTemplate);
    }
  }, [aiTemplate]);

  if (!entryId || !entry) return null;

  const displayName = entry.contactName ?? entry.contactPhone;
  const bgColor = avatarColor(displayName);
  const waPhone = entry.contactPhone.replace(/[^0-9]/g, "").replace(/^0/, "62");
  const waLink = template.trim()
    ? `https://wa.me/${waPhone}?text=${encodeURIComponent(template.trim())}`
    : `https://wa.me/${waPhone}`;

  const scoreChartData = (entry.scoreHistory ?? []).map((h) => ({
    label: h.cutoffWindow ?? (h.date ? new Date(h.date).toLocaleDateString("id-ID", { day: "2-digit", month: "short" }) : ""),
    score: h.score ?? 0,
  }));

  const isNextFUOverdue = entry.nextFollowupAt && new Date(entry.nextFollowupAt) < new Date();
  const logs = entry.followupLogs ?? [];
  const breakdown = analysis?.scoreBreakdown ?? null;

  function copyPhone() {
    navigator.clipboard.writeText(entry!.contactPhone);
    toast({ title: "Nomor disalin." });
  }

  const tabs: Array<{ key: EntryModalTab; label: string; badge?: number }> = [
    { key: "detail", label: "Detail" },
    { key: "signals", label: "Sinyal AI" },
    { key: "conversation", label: "Percakapan AI" },
    { key: "followup", label: "Follow Up", badge: logs.length || undefined },
  ];

  const colInfo = KANBAN_COLUMNS.find((c) => c.id === entry.status);

  return (
    <>
      <Dialog open={!!entryId} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
          {/* ── Header ── */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b pr-12 shrink-0">
            <div
              className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-sm font-bold text-white"
              style={{ background: bgColor }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold leading-snug truncate">{displayName}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground font-mono">{entry.contactPhone}</span>
                <button type="button" onClick={copyPhone} className="text-muted-foreground hover:text-foreground" title="Salin nomor">
                  <Copy className="w-3 h-3" />
                </button>
                <a href={`https://wa.me/${waPhone}`} target="_blank" rel="noopener noreferrer"
                  className="text-green-600 hover:text-green-700" title="Buka WhatsApp">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              {entry.channelType ? (
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  <span className="text-[11px] text-muted-foreground capitalize">{entry.channelType}</span>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              {scoreBadge(entry.currentScore)}
              {entry.cooled && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-950/40 dark:text-sky-300">
                  <Snowflake className="w-3 h-3" />
                  Mendingin
                </span>
              )}
              {colInfo ? (
                <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium"
                  style={{ color: colInfo.color, borderColor: colInfo.color + "40", background: colInfo.color + "15" }}>
                  {colInfo.label}
                </span>
              ) : null}
            </div>
          </div>

          {/* ── Tabs ── */}
          <div className="flex border-b px-5 shrink-0 overflow-x-auto">
            {tabs.map(({ key, label, badge }) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                className={cn(
                  "px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0",
                  tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                )}>
                {label}
                {badge ? (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                    {badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* ── Body ── */}
          <div className="flex-1 overflow-y-auto px-5 py-4">

            {/* ── Tab: Detail ── */}
            {tab === "detail" ? (
              <div className="space-y-4">

                {/* Status row — like Pipeline.tsx stage selector */}
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Pipeline</span>
                    {!editingStatus && (
                      <button
                        type="button"
                        onClick={() => setEditingStatus(true)}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Ubah
                      </button>
                    )}
                  </div>
                  {editingStatus ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {KANBAN_COLUMNS.map((col) => (
                          <button
                            key={col.id}
                            type="button"
                            onClick={() => changeStatus({ id: pipelineId, eid: entry.id, data: { status: col.id } })}
                            disabled={changingStatus || entry.status === col.id}
                            className={cn(
                              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all",
                              entry.status === col.id
                                ? "opacity-50 cursor-default"
                                : "hover:scale-105 cursor-pointer"
                            )}
                            style={{
                              color: col.color,
                              borderColor: col.color + "60",
                              background: col.color + "15",
                            }}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ background: col.color }} />
                            {col.label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingStatus(false)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Batal
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {colInfo ? (
                        <span
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border"
                          style={{ color: colInfo.color, borderColor: colInfo.color + "60", background: colInfo.color + "15" }}
                        >
                          <span className="w-2 h-2 rounded-full" style={{ background: colInfo.color }} />
                          {colInfo.label}
                        </span>
                      ) : <span className="text-xs text-muted-foreground">{entry.status}</span>}
                    </div>
                  )}
                </div>

                {/* Contact info row */}
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground text-xs">Nomor:</span>
                    <span className="font-mono text-xs font-medium">{entry.contactPhone}</span>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      onClick={() => navigator.clipboard.writeText(entry!.contactPhone).then(() => toast({ title: "Nomor disalin" }))}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={`https://wa.me/${entry.contactPhone.replace(/[^0-9]/g, "").replace(/^0/, "62")}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-green-600 hover:text-green-700"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  {entry.channelType ? (
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground text-xs">Channel:</span>
                      <span className="text-xs capitalize">{entry.channelType}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground text-xs">Masuk pipeline:</span>
                    <span className="text-xs">{formatDate(entry.enteredAt)}</span>
                  </div>
                  {analysis?.cutoffWindowEnd ? (
                    <div className="flex items-center gap-2">
                      <Brain className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground text-xs">Analisa AI terakhir:</span>
                      <span className="text-xs">{formatDate(analysis.cutoffWindowEnd)}</span>
                    </div>
                  ) : null}
                </div>

                {/* Value + score summary row */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Estimasi Nilai</p>
                    {entry.estimatedValue ? (
                      <p className="text-sm font-bold text-primary">{formatRupiah(entry.estimatedValue)}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">—</p>
                    )}
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Skor AI</p>
                    <p className="text-sm font-bold" style={{ color: scoreColor(entry.currentScore) }}>
                      {entry.currentScore} — {scoreLabel(entry.currentScore)}
                    </p>
                  </div>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className="text-lg font-bold">{entry.followupCount}</p>
                    <p className="text-[10px] text-muted-foreground">FU Terkirim</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className="text-xs font-medium truncate">{formatRelative(entry.lastFollowupAt)}</p>
                    <p className="text-[10px] text-muted-foreground">FU Terakhir</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className={cn(
                      "text-xs font-medium truncate",
                      isNextFUOverdue ? "text-rose-600" : "text-foreground"
                    )}>
                      {entry.nextFollowupAt ? formatRelative(entry.nextFollowupAt) : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">FU Berikutnya</p>
                  </div>
                </div>

                {/* Product interest */}
                {entry.productInterest ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Produk Diminati</p>
                    <div className="flex flex-wrap gap-1.5">
                      {entry.productInterest.split(",").map((p, i) => (
                        <span key={i} className="rounded-full bg-primary/10 text-primary px-2.5 py-1 text-xs font-medium">
                          {p.trim()}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Catatan AI — prominent notes from AI analysis */}
                {analysis?.aiNotes ? (
                  <div className="rounded-xl border border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-700/40 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-semibold text-sm">
                      <Brain className="w-4 h-4 shrink-0" />
                      Catatan AI
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                      {analysis.aiNotes}
                    </p>
                  </div>
                ) : null}

                {/* AI Recommendation — prominent action card */}
                {analysis?.recommendation ? (
                  <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-primary font-semibold text-sm">
                      <Lightbulb className="w-4 h-4 shrink-0" />
                      Rekomendasi AI — Tindakan untuk Customer Ini
                    </div>
                    <p className="text-sm leading-relaxed">{analysis.recommendation}</p>
                    <Button size="sm" className="h-7 text-xs gap-1.5 mt-1"
                      onClick={() => { setTemplate(analysis.recommendation ?? ""); setTab("followup"); }}>
                      <Send className="w-3 h-3" />Gunakan sebagai Pesan Follow Up
                    </Button>
                  </div>
                ) : analysis ? (
                  <div className="rounded-xl border border-dashed p-4 text-center">
                    <Brain className="w-6 h-6 mx-auto mb-1.5 text-muted-foreground opacity-40" />
                    <p className="text-xs text-muted-foreground">Belum ada rekomendasi AI untuk customer ini.</p>
                  </div>
                ) : null}

                {/* Do not followup info */}
                {entry.doNotFollowup && entry.doNotFollowupReason ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-xs font-semibold text-destructive mb-1 flex items-center gap-1">
                      <Ban className="w-3.5 h-3.5" />Follow-up Dihentikan
                    </p>
                    <p className="text-xs text-muted-foreground">{entry.doNotFollowupReason}</p>
                  </div>
                ) : null}

                {/* Stop followup button */}
                {entry.status !== "do_not_followup" ? (
                  <Button
                    variant="outline"
                    className="w-full text-destructive hover:text-destructive gap-2"
                    onClick={() => doNotFollowup({ id: pipelineId, eid: entry.id, data: { reason: "Diblokir manual" } })}
                    disabled={blocking}
                  >
                    {blocking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                    Hentikan Follow-up
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* ── Tab: Sinyal AI ── */}
            {tab === "signals" ? (
              <div className="space-y-5">
                {/* Score gauge */}
                <div className="flex items-center gap-6 p-4 rounded-xl border bg-muted/20">
                  <ScoreGauge score={entry.currentScore} />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Skor saat ini:</span>{" "}
                      <span style={{ color: scoreColor(entry.currentScore) }} className="font-semibold">
                        {entry.currentScore} — {scoreLabel(entry.currentScore)}
                      </span>
                    </div>
                    {entry.estimatedValue ? (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Estimasi:</span>{" "}
                        {formatRupiah(entry.estimatedValue)}
                      </div>
                    ) : null}
                    {entry.productInterest ? (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Produk:</span>{" "}
                        {entry.productInterest}
                      </div>
                    ) : null}
                    <div className="text-[10px] text-muted-foreground">
                      Masuk {formatDate(entry.enteredAt)}
                    </div>
                  </div>
                </div>

                {/* Score history chart */}
                {scoreChartData.length > 1 ? (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Riwayat Skor</p>
                    <div className="h-36">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={scoreChartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                          <defs>
                            <linearGradient id="aiScoreGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={scoreColor(entry.currentScore)} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={scoreColor(entry.currentScore)} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                            formatter={(v: number) => [`Skor: ${v}`, ""]} />
                          <Area type="monotone" dataKey="score" stroke={scoreColor(entry.currentScore)}
                            fill="url(#aiScoreGrad)" strokeWidth={2}
                            dot={{ r: 3, fill: scoreColor(entry.currentScore) }} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ) : scoreChartData.length === 1 ? (
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Riwayat Skor</p>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold"
                        style={{ backgroundColor: scoreColor(scoreChartData[0].score) }}>
                        {scoreChartData[0].score}
                      </div>
                      <span className="text-xs text-muted-foreground">{scoreChartData[0].label}</span>
                    </div>
                  </div>
                ) : null}

                {/* Score reason from analysis */}
                {analysis?.scoreReason ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Alasan Skor {entry.currentScore}
                    </p>
                    <p className="text-xs text-foreground leading-relaxed">{analysis.scoreReason}</p>
                  </div>
                ) : null}

                {/* AI Notes */}
                {analysis?.aiNotes ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                      <Brain className="w-3 h-3" />Catatan AI
                    </p>
                    <p className="text-xs text-foreground leading-relaxed">{analysis.aiNotes}</p>
                  </div>
                ) : null}

                {/* Full score history as timeline */}
                {(entry.scoreHistory ?? []).length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Riwayat Skor ({entry.scoreHistory!.length} analisa)
                    </p>
                    <div className="space-y-2">
                      {entry.scoreHistory!.map((h, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                            style={{ backgroundColor: scoreColor(h.score ?? 0) }}>
                            {h.score ?? 0}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {h.cutoffWindow ? <span className="font-medium text-foreground">{h.cutoffWindow} · </span> : null}
                            {formatDate(h.date)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : !analysis ? (
                  <div className="py-10 text-center">
                    <Brain className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                    <p className="text-sm text-muted-foreground">Belum ada data analisa AI.</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* ── Tab: Percakapan AI ── */}
            {tab === "conversation" ? (
              <div className="space-y-4">
                {/* Analysis window header */}
                {analysis ? (
                  <>
                    <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <BrainCircuit className="w-4 h-4 text-primary shrink-0" />
                        Percakapan yang Dianalisa AI
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {analysis.cutoffWindowStart ? (
                          <div>
                            <p className="text-muted-foreground mb-0.5">Dari</p>
                            <p className="font-medium">{formatDate(analysis.cutoffWindowStart)}</p>
                          </div>
                        ) : null}
                        {analysis.cutoffWindowEnd ? (
                          <div>
                            <p className="text-muted-foreground mb-0.5">Sampai</p>
                            <p className="font-medium">{formatDate(analysis.cutoffWindowEnd)}</p>
                          </div>
                        ) : null}
                        <div className="col-span-2">
                          <p className="text-muted-foreground mb-0.5">Cutoff analisa</p>
                          <p className="font-medium">{formatDate(analysis.cutoffDatetime)}</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground border-t pt-2">
                        AI menganalisa semua pesan dalam window di atas untuk menentukan skor, sinyal beli, dan rekomendasi.
                      </p>
                    </div>

                    {/* Score breakdown bars */}
                    {breakdown ? (
                      <div className="rounded-xl border bg-card p-4 space-y-3">
                        <p className="text-sm font-semibold">Breakdown Skor AI</p>
                        <p className="text-xs text-muted-foreground -mt-1">Faktor-faktor yang ditemukan AI dalam percakapan</p>

                        {breakdown.buying_signal != null ? (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Sinyal Beli</span>
                              <span className="font-medium">{breakdown.buying_signal} / 30</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-indigo-500"
                                style={{ width: `${(breakdown.buying_signal / 30) * 100}%` }} />
                            </div>
                          </div>
                        ) : null}
                        {breakdown.urgency != null ? (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Urgensi</span>
                              <span className="font-medium">{breakdown.urgency} / 20</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-amber-500"
                                style={{ width: `${(breakdown.urgency / 20) * 100}%` }} />
                            </div>
                          </div>
                        ) : null}
                        {breakdown.engagement != null ? (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Engagement</span>
                              <span className="font-medium">{breakdown.engagement} / 20</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-blue-500"
                                style={{ width: `${(breakdown.engagement / 20) * 100}%` }} />
                            </div>
                          </div>
                        ) : null}
                        {breakdown.commitment != null ? (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Komitmen</span>
                              <span className="font-medium">{breakdown.commitment} / 15</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-emerald-500"
                                style={{ width: `${(breakdown.commitment / 15) * 100}%` }} />
                            </div>
                          </div>
                        ) : null}
                        {breakdown.product_fit != null ? (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Kesesuaian Produk</span>
                              <span className="font-medium">{breakdown.product_fit} / 10</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-violet-500"
                                style={{ width: `${(breakdown.product_fit / 10) * 100}%` }} />
                            </div>
                          </div>
                        ) : null}
                        {breakdown.barrier_adjustment != null ? (
                          <div className="flex justify-between text-xs pt-2 border-t">
                            <span className="text-muted-foreground">Penyesuaian Hambatan</span>
                            <span className={cn("font-semibold", breakdown.barrier_adjustment < 0 ? "text-rose-600" : "text-emerald-600")}>
                              {breakdown.barrier_adjustment > 0 ? "+" : ""}{breakdown.barrier_adjustment}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Score reason */}
                    {analysis.scoreReason ? (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Sinyal yang Ditemukan AI
                        </p>
                        <p className="text-sm leading-relaxed">{analysis.scoreReason}</p>
                      </div>
                    ) : null}

                    {/* AI Notes */}
                    {analysis.aiNotes ? (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Catatan AI</p>
                        <p className="text-sm leading-relaxed">{analysis.aiNotes}</p>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="py-16 text-center">
                    <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Memuat data analisa percakapan…</p>
                  </div>
                )}
              </div>
            ) : null}

            {/* ── Tab: Follow Up ── */}
            {tab === "followup" ? (
              <div className="space-y-4">
                {/* Status overview */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className="text-lg font-bold">{entry.followupCount}</p>
                    <p className="text-[10px] text-muted-foreground">Terkirim</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className="text-xs font-medium truncate">{formatRelative(entry.lastFollowupAt)}</p>
                    <p className="text-[10px] text-muted-foreground">Terakhir</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className={cn(
                      "text-xs font-medium truncate",
                      isNextFUOverdue ? "text-rose-600" : "text-foreground"
                    )}>
                      {entry.nextFollowupAt ? formatRelative(entry.nextFollowupAt) : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Berikutnya</p>
                  </div>
                </div>

                {/* Template textarea */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Pesan WhatsApp</p>
                    {aiTemplate && template !== aiTemplate ? (
                      <button type="button" className="text-[10px] text-primary hover:underline"
                        onClick={() => setTemplate(aiTemplate)}>
                        Reset ke pesan AI terakhir
                      </button>
                    ) : null}
                  </div>
                  <Textarea value={template} onChange={(e) => setTemplate(e.target.value)}
                    placeholder="Tulis pesan follow up manual, atau gunakan pesan AI terakhir di bawah…"
                    className="text-xs min-h-[100px]" />
                  {aiTemplate && !template ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 w-full"
                      onClick={() => setTemplate(aiTemplate)}>
                      <Brain className="w-3 h-3" />Gunakan Pesan AI Terakhir
                    </Button>
                  ) : null}
                </div>

                {/* WA send button */}
                <a href={waLink} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-md text-sm font-medium h-9 px-4 bg-green-600 hover:bg-green-700 text-white transition-colors w-full">
                  <Smartphone className="w-4 h-4" />
                  Kirim via WhatsApp
                </a>

                {/* Follow-up log */}
                {logs.length === 0 ? (
                  <div className="py-8 text-center">
                    <Send className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                    <p className="text-sm text-muted-foreground">Belum ada follow-up terkirim.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Riwayat Follow Up ({logs.length})
                    </p>
                    {logs.map((log) => (
                      <div key={log.id} className="border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">Follow-up #{log.followupNumber}</span>
                          <span className="text-[10px] text-muted-foreground">{formatRelative(log.sentAt)}</span>
                        </div>
                        <div className="rounded-md bg-muted/50 p-2.5">
                          <p className="text-xs leading-relaxed">{log.messageSent}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {log.wasReplied ? (
                            <span className="text-xs text-green-600 flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />Dibalas {log.repliedAt ? formatRelative(log.repliedAt) : ""}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" />Belum dibalas
                            </span>
                          )}
                          <button type="button"
                            className="text-[10px] text-primary hover:underline ml-auto"
                            onClick={() => setTemplate(log.messageSent)}>
                            Gunakan pesan ini
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t shrink-0">
            <Button variant="outline" size="sm" onClick={onClose}>Tutup</Button>
          </div>
        </DialogContent>
      </Dialog>

    </>
  );
}

// ─── Kanban: EntryColumn ───────────────────────────────────────────────────────

function EntryColumn({
  id, label, color, isTerminal, count, total, children,
}: {
  id: string; label: string; color: string; isTerminal: boolean;
  count: number; total: number; children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: isTerminal });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col w-72 shrink-0 rounded-lg border bg-muted/30",
        isOver && !isTerminal && "ring-2 ring-primary"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-sm font-medium truncate flex-1">{label}</span>
        {isTerminal && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Terminal</Badge>}
        <Badge variant="outline" className="ml-auto text-[10px]">{count}</Badge>
      </div>
      <div className="px-3 py-1 text-[11px] text-muted-foreground border-b">
        {total > 0 ? formatRupiah(total) : <span className="opacity-50">Rp 0</span>}
      </div>
      <div className="flex flex-col flex-1 gap-2 p-2 overflow-y-auto">{children}</div>
    </div>
  );
}

// ─── Kanban: EntryCard ─────────────────────────────────────────────────────────

function EntryCard({
  entry, dragging, canDrag, onClick,
}: {
  entry: AiPipelineEntry; dragging?: boolean; canDrag: boolean; onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.id,
    disabled: !canDrag,
  });
  const displayName = entry.contactName ?? entry.contactPhone;
  const bgColor = avatarColor(displayName);
  const isNextFUOverdue = entry.nextFollowupAt && new Date(entry.nextFollowupAt) < new Date();
  const isNextFUSoon = !isNextFUOverdue && entry.nextFollowupAt
    && (new Date(entry.nextFollowupAt).getTime() - Date.now()) < 3600_000;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border bg-background p-2.5 shadow-sm cursor-default transition-colors",
        (isDragging || dragging) && "opacity-60",
        isNextFUOverdue && "border-rose-400/70 bg-rose-50/40 dark:bg-rose-950/20"
      )}
    >
      <div className="flex items-start gap-1.5">
        {canDrag && (
          <button
            type="button"
            className="mt-0.5 cursor-grab text-muted-foreground touch-none active:cursor-grabbing shrink-0"
            {...attributes}
            {...listeners}
            aria-label="Pindahkan"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        )}
        <button type="button" className="flex-1 min-w-0 text-left" onClick={onClick}>
          {/* Avatar + name */}
          <div className="flex items-center gap-1.5">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
              style={{ backgroundColor: bgColor }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm font-medium truncate flex-1 min-w-0">
              {displayName}
            </span>
          </div>

          {/* Phone if name exists */}
          {entry.contactName && (
            <p className="text-[11px] text-muted-foreground truncate ml-[30px]">{entry.contactPhone}</p>
          )}

          {/* Channel type badge */}
          {entry.channelType ? (
            <div className="flex items-center gap-1 mt-0.5 ml-[30px]">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="text-[10px] text-muted-foreground capitalize">{entry.channelType}</span>
            </div>
          ) : null}

          {/* AI Score + badges row */}
          <div className="flex items-center gap-1.5 mt-1.5 ml-[30px] flex-wrap">
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
              style={{ backgroundColor: scoreColor(entry.currentScore) }}
            >
              <TrendingUp className="w-3 h-3" />
              {entry.currentScore} · {scoreLabel(entry.currentScore)}
            </span>
            {entry.followupCount > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MessageSquare className="w-3 h-3" />
                {entry.followupCount}x
              </span>
            )}
            {isNextFUOverdue && (
              <span className="text-[10px] font-semibold text-rose-600 flex items-center gap-0.5">
                <Clock className="w-3 h-3" />
                Terlambat
              </span>
            )}
            {entry.cooled && (
              <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-950/40 dark:text-sky-300">
                <Snowflake className="w-3 h-3" />
                Mendingin
              </span>
            )}
          </div>

          {/* Product interest */}
          {entry.productInterest && (
            <p className="text-[11px] text-muted-foreground truncate mt-1 ml-[30px]">
              {entry.productInterest}
            </p>
          )}

          {/* Estimated value */}
          {entry.estimatedValue ? (
            <div className="mt-1 ml-[30px]">
              <span className="text-xs font-semibold text-primary">
                {formatRupiah(entry.estimatedValue)}
              </span>
            </div>
          ) : null}

          {/* Footer: last activity + next FU */}
          <div className="flex items-center justify-between mt-1.5 ml-[30px]">
            <span className="text-[10px] text-muted-foreground">
              {formatRelative(entry.enteredAt)}
            </span>
            {entry.nextFollowupAt ? (
              <span className={cn(
                "text-[10px] flex items-center gap-0.5 font-medium",
                isNextFUOverdue ? "text-rose-600" : isNextFUSoon ? "text-amber-600" : "text-muted-foreground"
              )}>
                <Clock className="w-2.5 h-2.5" />
                {formatRelative(entry.nextFollowupAt)}
              </span>
            ) : null}
          </div>
        </button>
      </div>
    </div>
  );
}

// ─── Kanban Board (Papan) ──────────────────────────────────────────────────────

function EntriesKanban({ pipelineId }: { pipelineId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useListAiPipelineEntries(pipelineId, { pageSize: 500 });
  const entries = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(() =>
    !search ? entries : entries.filter((e) =>
      e.contactPhone.includes(search) ||
      (e.contactName ?? "").toLowerCase().includes(search.toLowerCase())
    ),
    [entries, search]
  );

  const byStatus = useMemo(() => {
    const map = new Map<string, AiPipelineEntry[]>();
    for (const col of KANBAN_COLUMNS) map.set(col.id, []);
    for (const e of filtered) {
      const key = (e.status ?? "new") as string;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [filtered]);

  const activeEntry = useMemo(() => entries.find((e) => e.id === activeId) ?? null, [entries, activeId]);

  const { mutate: updateStatus } = useUpdateAiPipelineEntry({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAiPipelineEntriesQueryKey(pipelineId) });
      },
      onError: () => {
        qc.invalidateQueries({ queryKey: getListAiPipelineEntriesQueryKey(pipelineId) });
        toast({ title: "Gagal memindahkan", variant: "destructive" });
      },
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(Number(e.active.id));
  }, []);

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const entryId = Number(active.id);
    const entry = entries.find((en) => en.id === entryId);
    if (!entry) return;
    const newStatus = String(over.id) as EntryStatus;
    if (entry.status === newStatus) return;
    const col = KANBAN_COLUMNS.find((c) => c.id === newStatus);
    if (col?.isTerminal) return; // can't drag into terminal via dnd — user must use drawer
    updateStatus({ id: pipelineId, eid: entryId, data: { status: newStatus } });
  }, [entries, pipelineId, updateStatus]);

  // Summary bar metrics (computed from all entries, not just filtered)
  const termStatuses = useMemo(() => new Set<string>(KANBAN_COLUMNS.filter((c) => c.isTerminal).map((c) => c.id)), []);
  const activeEntries = useMemo(() => entries.filter((e) => !termStatuses.has(e.status)), [entries, termStatuses]);
  const overdueEntries = useMemo(
    () => activeEntries.filter((e) => e.nextFollowupAt && new Date(e.nextFollowupAt) < new Date()),
    [activeEntries]
  );
  const totalActiveValue = useMemo(
    () => activeEntries.reduce((s, e) => s + (e.estimatedValue ?? 0), 0),
    [activeEntries]
  );
  const repliedCount = useMemo(() => entries.filter((e) => e.status === "replied").length, [entries]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      {/* Search + summary bar */}
      <div className="px-4 py-2 border-b flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cari kontak..."
            className="pl-9 h-8 text-sm w-52"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {entries.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span>
              <strong className="text-foreground">{activeEntries.length}</strong> kontak aktif
            </span>
            {overdueEntries.length > 0 && (
              <span className="flex items-center gap-1 text-rose-600 font-medium">
                <Clock className="w-3.5 h-3.5" />
                <strong>{overdueEntries.length}</strong> FU terlambat
              </span>
            )}
            {repliedCount > 0 && (
              <span className="flex items-center gap-1 text-green-600">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <strong>{repliedCount}</strong> membalas
              </span>
            )}
            {totalActiveValue > 0 && (
              <span className="text-primary font-medium">
                {formatRupiah(totalActiveValue)}
              </span>
            )}
          </div>
        )}
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto">
          <div className="flex h-full gap-3 p-4 min-w-max">
            {KANBAN_COLUMNS.map((col) => {
              const items = byStatus.get(col.id) ?? [];
              const total = items.reduce((sum, e) => sum + (e.estimatedValue ?? 0), 0);
              return (
                <EntryColumn
                  key={col.id}
                  id={col.id}
                  label={col.label}
                  color={col.color}
                  isTerminal={col.isTerminal}
                  count={items.length}
                  total={total}
                >
                  {items.length === 0 ? (
                    <p className="px-1 py-6 text-xs text-center text-muted-foreground">Kosong</p>
                  ) : (
                    items.map((entry) => (
                      <EntryCard
                        key={entry.id}
                        entry={entry}
                        canDrag={!col.isTerminal}
                        onClick={() => setSelectedEntryId(entry.id)}
                      />
                    ))
                  )}
                </EntryColumn>
              );
            })}
          </div>
        </div>
        <DragOverlay>
          {activeEntry ? (
            <EntryCard entry={activeEntry} canDrag dragging />
          ) : null}
        </DragOverlay>
      </DndContext>

      <EntryModal
        pipelineId={pipelineId}
        entryId={selectedEntryId}
        onClose={() => setSelectedEntryId(null)}
      />
    </>
  );
}

// ─── Settings Tab ──────────────────────────────────────────────────────────────

const FOLLOWUP_PRESETS = [
  { label: "24 jam", value: "24h" },
  { label: "48 jam", value: "48h" },
  { label: "72 jam", value: "72h" },
  { label: "7 hari", value: "168h" },
];

const PROMPT_TEMPLATES = [
  { label: "Sales Umum", value: `Kamu adalah AI analis sales yang bertugas menilai percakapan WhatsApp dengan calon pembeli. Evaluasi tingkat ketertarikan, urgensi pembelian, dan peluang konversi berdasarkan sinyal dalam percakapan. Berikan skor 0-100 dan rekomendasi tindak lanjut yang spesifik.` },
  { label: "Properti", value: `Kamu adalah AI analis properti yang menganalisa percakapan calon pembeli/penyewa. Perhatikan budget, lokasi yang diinginkan, timeline keputusan, dan sinyal serius seperti pertanyaan spesifik tentang spesifikasi, harga final, atau kunjungan survei. Berikan skor 0-100.` },
  { label: "Keuangan/Asuransi", value: `Kamu adalah AI analis produk keuangan dan asuransi. Analisa percakapan untuk mendeteksi kebutuhan finansial, toleransi risiko, kemampuan bayar premi, dan urgensi perlindungan. Identifikasi apakah calon klien dalam tahap eksplorasi atau siap membeli. Berikan skor 0-100.` },
  { label: "E-commerce", value: `Kamu adalah AI analis e-commerce yang mengevaluasi percakapan calon pembeli toko online. Perhatikan pertanyaan tentang stok, harga, diskon, pengiriman, dan tanda-tanda akan checkout. Bedakan antara browser biasa dan pembeli serius. Berikan skor 0-100.` },
  { label: "Jasa/Service", value: `Kamu adalah AI analis bisnis jasa yang menganalisa percakapan calon klien. Identifikasi kebutuhan spesifik, anggaran, timeline proyek, dan level keputusan (pengambil keputusan vs. penanya biasa). Perhatikan sinyal seperti pertanyaan harga detail atau permintaan proposal. Berikan skor 0-100.` },
];

function computeWindows(times: string[]): Array<{ time: string; window: string }> {
  const sorted = [...times].sort();
  return sorted.map((time, i) => {
    const prev = i === 0 ? "00:00" : incrementMinute(sorted[i - 1]);
    return { time, window: `${prev} – ${time}` };
  });
}

function incrementMinute(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (m === 59) return `${String(h + 1).padStart(2, "0")}:00`;
  return `${String(h).padStart(2, "0")}:${String(m + 1).padStart(2, "0")}`;
}

function SettingsTab({ pipeline, onDeleted }: { pipeline: AiPipeline; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: channels } = useListChannels();
  const { data: labels } = useListCustomerLabels();

  const [name, setName] = useState(pipeline.name);
  const [description, setDescription] = useState(pipeline.description ?? "");
  const [channelIds, setChannelIds] = useState<number[]>(pipeline.channelIds);
  const [excludeLabelIds, setExcludeLabelIds] = useState<number[]>(pipeline.excludeLabelIds ?? []);
  const [isActive, setIsActive] = useState(pipeline.isActive);
  const [cutoffTimes, setCutoffTimes] = useState<string[]>(pipeline.cutoffTimes);
  const [scoreThreshold, setScoreThreshold] = useState(pipeline.scoreThreshold);
  const [autoFollowupEnabled, setAutoFollowupEnabled] = useState(pipeline.autoFollowupEnabled ?? false);
  const [followupIntervals, setFollowupIntervals] = useState<string[]>(
    (pipeline.followupIntervals as string[] | null) ?? []
  );
  const [customPrompt, setCustomPrompt] = useState(pipeline.customPrompt ?? "");
  const [directionFilter, setDirectionFilter] = useState(pipeline.directionFilter ?? true);
  const [sampleMessages, setSampleMessages] = useState("");
  const [testResult, setTestResult] = useState<{ score: number | null; status: string | null; recommendation: string | null } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [promptVersions, setPromptVersions] = useState<Array<{ id: number; version: number; promptText: string; changedAt: string; changedByName: string | null }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const promptLen = customPrompt.length;
  const promptValid = promptLen === 0 || (promptLen >= 80 && promptLen <= 1500);

  const loadHistory = async () => {
    const res = await fetch(`/api/ai-pipeline/${pipeline.id}/prompt-versions`, { credentials: "include" });
    if (res.ok) setPromptVersions(await res.json());
  };

  const runTest = async () => {
    if (!customPrompt || customPrompt.length < 80) return;
    if (!sampleMessages.trim()) { setTestError("Masukkan contoh percakapan terlebih dahulu"); return; }
    setIsTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const res = await fetch(`/api/ai-pipeline/${pipeline.id}/test-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ prompt: customPrompt, sampleMessages: sampleMessages.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setTestError((err as any).error ?? "Gagal menguji prompt");
      } else {
        setTestResult(await res.json());
      }
    } catch { setTestError("Gagal terhubung ke server"); }
    finally { setIsTesting(false); }
  };

  const { mutate: update, isPending: saving } = useUpdateAiPipeline({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAiPipelineQueryKey(pipeline.id) });
        qc.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        toast({ title: "Pengaturan disimpan." });
      },
      onError: () => toast({ title: "Gagal menyimpan", variant: "destructive" }),
    },
  });

  const { mutate: deletePipeline, isPending: deleting } = useDeleteAiPipeline({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        toast({ title: "Pipeline dihapus." });
        onDeleted();
      },
      onError: () => toast({ title: "Gagal menghapus pipeline", variant: "destructive" }),
    },
  });

  const windows = computeWindows(cutoffTimes);
  const toggleInterval = (v: string) =>
    setFollowupIntervals((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]);

  const handleSave = () => {
    update({
      id: pipeline.id,
      data: {
        name: name.trim(),
        description: description.trim() || undefined,
        isActive,
        channelIds,
        excludeLabelIds,
        cutoffTimes: [...cutoffTimes].sort(),
        scoreThreshold,
        autoFollowupEnabled,
        followupIntervals: followupIntervals.slice(0, 3),
        customPrompt: customPrompt.trim() || undefined,
        directionFilter,
      },
    });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Nama Pipeline</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </div>
        <div className="space-y-2">
          <Label>Deskripsi (opsional)</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </div>
      </div>

      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <Label>Status</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pipeline nonaktif tidak menjalankan analisa otomatis
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">{isActive ? "Aktif" : "Nonaktif"}</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </div>
      </div>

      {/* AI Prompt section */}
      <div className="border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-muted-foreground" />
            <Label>Custom Prompt AI</Label>
            {pipeline.promptVersion && pipeline.promptVersion > 1 && (
              <Badge variant="secondary" className="text-xs">v{pipeline.promptVersion}</Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs text-muted-foreground"
            onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory(); }}
          >
            <History className="h-3.5 w-3.5" />
            Riwayat
          </Button>
        </div>

        {showHistory && (
          <div className="space-y-2 border rounded-lg p-3 bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase">Riwayat Perubahan Prompt</p>
            {promptVersions.length === 0 && (
              <p className="text-xs text-muted-foreground">Belum ada perubahan prompt tersimpan.</p>
            )}
            {promptVersions.map((v) => (
              <div key={v.id} className="border rounded p-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">v{v.version}</span>
                  <span className="text-xs text-muted-foreground">{v.changedByName ?? "–"} · {new Date(v.changedAt).toLocaleDateString("id-ID")}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => { setCustomPrompt(v.promptText); setShowHistory(false); }}
                  >
                    Pakai
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{v.promptText}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {PROMPT_TEMPLATES.map((t) => (
            <Button
              key={t.label}
              variant={customPrompt === t.value ? "default" : "outline"}
              size="sm"
              className="gap-1"
              onClick={() => setCustomPrompt(t.value)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t.label}
            </Button>
          ))}
          {customPrompt.length > 0 && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCustomPrompt("")}>
              Reset ke default
            </Button>
          )}
        </div>

        <div className="space-y-1">
          <Textarea
            placeholder="Tulis instruksi untuk AI, minimal 80 karakter... (biarkan kosong untuk menggunakan prompt bawaan)"
            rows={5}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            maxLength={1500}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {promptLen > 0 && !promptValid && <span className="text-destructive">Minimal 80 karakter</span>}
            </span>
            <span className={promptLen > 1400 ? "text-yellow-600" : ""}>{promptLen}/1500</span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Filter Arah Percakapan</Label>
            <p className="text-xs text-muted-foreground mt-0.5">Lewati percakapan di mana agen mengirim lebih banyak pesan</p>
          </div>
          <Switch checked={directionFilter} onCheckedChange={setDirectionFilter} />
        </div>

        {customPrompt.length >= 80 && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">Uji Prompt</p>
            </div>
            <Textarea
              placeholder="Tempel contoh percakapan di sini untuk menguji prompt..."
              rows={3}
              value={sampleMessages}
              onChange={(e) => setSampleMessages(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={runTest} disabled={isTesting} className="gap-2">
              {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Jalankan Test
            </Button>
            {testError && <p className="text-xs text-destructive">{testError}</p>}
            {testResult && (
              <div className="rounded-lg bg-muted/50 border p-3 space-y-1 text-sm">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">Skor:</span>
                  <span className="font-bold">{testResult.score ?? "–"}</span>
                  {testResult.status && <span className="text-muted-foreground">{testResult.status}</span>}
                </div>
                {testResult.recommendation && (
                  <p className="text-xs text-muted-foreground">{testResult.recommendation}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Channel</Label>
        <div className="flex flex-wrap gap-2">
          {(channels ?? []).map((c: Channel) => (
            <button
              key={c.id}
              onClick={() => setChannelIds((prev) =>
                prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]
              )}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-colors",
                channelIds.includes(c.id) ? "border-primary bg-primary/10 text-primary" : "hover:border-primary/50"
              )}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Kecualikan Kontak dengan Label</Label>
        <p className="text-xs text-muted-foreground">
          Kontak yang memiliki label ini tidak akan dianalisa AI. Gunakan untuk
          mengecualikan tim, teman, keluarga, atau kontak non-bisnis.
        </p>
        {(labels ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada label.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(labels ?? []).map((l: CustomerLabel) => (
              <button
                key={l.id}
                onClick={() => setExcludeLabelIds((prev) =>
                  prev.includes(l.id) ? prev.filter((x) => x !== l.id) : [...prev, l.id]
                )}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-colors",
                  excludeLabelIds.includes(l.id) ? "border-primary bg-primary/10 text-primary" : "hover:border-primary/50"
                )}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Label>Jadwal Analisa</Label>
        {windows.map(({ time, window }, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <input
              type="time"
              value={time}
              onChange={(e) => {
                const t = [...cutoffTimes];
                t[idx] = e.target.value;
                setCutoffTimes(t);
              }}
              className="border rounded-md px-2 py-1 text-sm w-28"
            />
            <span className="text-xs text-muted-foreground flex-1">{window}</span>
            <Button
              variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => cutoffTimes.length > 1 && setCutoffTimes(cutoffTimes.filter((_, i) => i !== idx))}
              disabled={cutoffTimes.length <= 1}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {cutoffTimes.length < 6 && (
          <Button variant="outline" size="sm" onClick={() => setCutoffTimes([...cutoffTimes, "18:00"])} className="gap-1">
            + Tambah
          </Button>
        )}
      </div>

      <div className="space-y-3">
        <Label>Skor Minimum Pipeline: {scoreThreshold}</Label>
        <Slider min={0} max={100} step={1} value={[scoreThreshold]} onValueChange={([v]) => setScoreThreshold(v)} />
      </div>

      <div className="space-y-3 border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <Label>Follow-up Otomatis</Label>
          <Switch checked={autoFollowupEnabled} onCheckedChange={setAutoFollowupEnabled} />
        </div>
        {autoFollowupEnabled && (
          <div className="pt-2 border-t flex flex-wrap gap-3">
            {FOLLOWUP_PRESETS.map(({ label, value }) => (
              <label key={value} className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={followupIntervals.includes(value)} onCheckedChange={() => toggleInterval(value)} />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-4 border-t">
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive gap-2"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" /> Hapus Pipeline
        </Button>
        <Button onClick={handleSave} disabled={saving || name.trim().length < 3 || channelIds.length === 0} className="gap-2">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          <Save className="h-4 w-4" /> Simpan
        </Button>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus Pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              Pipeline <strong>{pipeline.name}</strong> akan dihapus permanen beserta semua data analisa.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deletePipeline({ id: pipeline.id })}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

type ViewMode = "board" | "analytics" | "analyses" | "settings";

export default function AIPipelineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const pipelineId = Number(id);
  const [location, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const initialView: ViewMode = location.endsWith("/edit") ? "settings" : "board";
  const [view, setView] = useState<ViewMode>(initialView);

  // Reset view to board when switching pipelines via tabs
  const prevPipelineId = useRef(pipelineId);
  useEffect(() => {
    if (prevPipelineId.current !== pipelineId) {
      prevPipelineId.current = pipelineId;
      setView("board");
    }
  }, [pipelineId]);

  const { data: allPipelines } = useListAiPipelines();
  const sortedPipelines = useMemo(
    () => (allPipelines ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [allPipelines]
  );

  const { data: pipeline, isLoading, isError } = useGetAiPipeline(pipelineId, {
    query: { queryKey: getGetAiPipelineQueryKey(pipelineId) },
  });

  const { mutate: runNow, isPending: running } = useRunAiPipelineNow({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAiPipelineDashboardStatsQueryKey(pipelineId) });
        toast({ title: "Analisa dimulai." });
      },
      onError: (err: any) => {
        if (err?.status === 409) {
          toast({ title: "Analisa sedang berjalan. Tunggu selesai.", variant: "destructive" });
        } else {
          toast({ title: "Gagal memulai analisa", variant: "destructive" });
        }
      },
    },
  });

  const { mutate: toggle, isPending: toggling } = useToggleAiPipeline({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAiPipelineQueryKey(pipelineId) });
        qc.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        toast({ title: pipeline?.isActive ? "Pipeline dinonaktifkan" : "Pipeline diaktifkan" });
      },
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !pipeline) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="text-muted-foreground">Pipeline tidak ditemukan.</p>
        <Button variant="outline" onClick={() => navigate("/ai-pipeline")}>Kembali</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b sm:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate("/ai-pipeline")}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="p-1.5 rounded-lg bg-primary/10 shrink-0">
            <BrainCircuit className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{pipeline.name}</h1>
            {pipeline.description && (
              <p className="text-xs text-muted-foreground truncate">{pipeline.description}</p>
            )}
          </div>
          <Badge
            className={cn(
              "text-xs shrink-0",
              pipeline.isActive
                ? "bg-green-100 text-green-700 border-green-200"
                : "bg-muted text-muted-foreground"
            )}
          >
            {pipeline.isActive ? "Aktif" : "Nonaktif"}
          </Badge>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runNow({ id: pipelineId })}
            disabled={running || !pipeline.isActive}
            className="gap-1.5"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Jalankan
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(pipeline.isActive ? "text-green-600" : "text-muted-foreground")}
            onClick={() => toggle({ id: pipelineId })}
            disabled={toggling}
          >
            <Power className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Pipeline tabs — switch between AI Pipelines (like Pipeline.tsx) ── */}
      {sortedPipelines.length > 1 && (
        <div className="flex items-center gap-0.5 px-4 border-b sm:px-6 overflow-x-auto">
          {sortedPipelines.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                if (p.id !== pipelineId) navigate(`/ai-pipeline/${p.id}`);
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors shrink-0 whitespace-nowrap",
                p.id === pipelineId
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  p.isActive ? "bg-green-500" : "bg-muted-foreground/40"
                )}
              />
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* ── View tabs ── */}
      <div className="flex items-center gap-1 px-4 border-b sm:px-6 overflow-x-auto">
        {(
          [
            { key: "board"     as const, label: "Papan",     icon: LayoutGrid  },
            { key: "analytics" as const, label: "Analitik",  icon: BarChart3   },
            { key: "analyses"  as const, label: "Analisa",   icon: BrainCircuit},
            { key: "settings"  as const, label: "Pengaturan",icon: Settings2   },
          ] as { key: ViewMode; label: string; icon: React.ElementType }[]
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors shrink-0 whitespace-nowrap",
              view === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Papan (kanban) ── */}
      {view === "board" && (
        <EntriesKanban pipelineId={pipelineId} />
      )}

      {/* ── Analitik ── */}
      {view === "analytics" && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <DashboardTab pipelineId={pipelineId} />
        </div>
      )}

      {/* ── Analisa ── */}
      {view === "analyses" && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <AnalysesTab pipelineId={pipelineId} />
        </div>
      )}

      {/* ── Pengaturan ── */}
      {view === "settings" && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <SettingsTab pipeline={pipeline} onDeleted={() => navigate("/ai-pipeline")} />
        </div>
      )}
    </div>
  );
}
