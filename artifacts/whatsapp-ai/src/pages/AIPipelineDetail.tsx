import { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetAiPipeline,
  useGetAiPipelineDashboardStats,
  useListAiPipelineAnalyses,
  useListAiPipelineEntries,
  useGetAiPipelineEntry,
  useDoNotFollowupAiPipelineEntry,
  useRunAiPipelineNow,
  useToggleAiPipeline,
  useUpdateAiPipeline,
  useDeleteAiPipeline,
  useListChannels,
  useListCustomerLabels,
  getGetAiPipelineQueryKey,
  getGetAiPipelineEntryQueryKey,
  getListAiPipelinesQueryKey,
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
  Filter,
  Ban,
  MessageSquare,
  Calendar,
  Eye,
  Save,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    converted: "bg-blue-100 text-blue-700",
    cold: "bg-gray-100 text-gray-700",
    do_not_followup: "bg-red-100 text-red-700",
  };
  const labels: Record<string, string> = {
    active: "Aktif",
    converted: "Dikonversi",
    cold: "Dingin",
    do_not_followup: "Jangan Follow-up",
  };
  return (
    <Badge className={cn("text-xs", map[status] ?? "bg-muted text-muted-foreground")}>
      {labels[status] ?? status}
    </Badge>
  );
}

// ─── Dashboard Tab ─────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
      <div className={cn("p-3 rounded-lg", color)}>
        <Icon className="h-5 w-5 text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function DashboardTab({ pipelineId }: { pipelineId: number }) {
  const { data: stats } = useGetAiPipelineDashboardStats(pipelineId, {
    query: { queryKey: getGetAiPipelineDashboardStatsQueryKey(pipelineId) },
  });

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }

  const scoreData = stats.scoreDistribution ?? [];

  return (
    <div className="space-y-6">
      {/* Today stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Dianalisa Hari Ini" value={stats.today.analyzed} icon={BrainCircuit} color="bg-purple-500" />
        <StatCard label="Masuk Pipeline" value={stats.today.enteredPipeline} icon={Target} color="bg-blue-500" />
        <StatCard label="Opportunity" value={stats.today.opportunitiesCreated} icon={TrendingUp} color="bg-green-500" />
        <StatCard label="Follow-up Dikirim" value={stats.today.followupsSent} icon={MessageSquare} color="bg-orange-500" />
      </div>

      {/* Score distribution */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Distribusi Skor (7 Hari Terakhir)</h3>
        {scoreData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Belum ada data analisa</p>
        ) : (
          <div className="space-y-2">
            {scoreData.map((d) => {
              const pct = scoreData.reduce((s, x) => s + (x.count ?? 0), 0) > 0
                ? Math.round(((d.count ?? 0) / scoreData.reduce((s, x) => s + (x.count ?? 0), 0)) * 100)
                : 0;
              return (
                <div key={d.range} className="flex items-center gap-3">
                  <span className="text-xs w-24 text-right text-muted-foreground">{d.range}</span>
                  <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: d.color ?? "#888" }}
                    />
                  </div>
                  <span className="text-xs w-8 text-right font-medium">{d.count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent analyses */}
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <h3 className="font-semibold text-sm">Analisa Terbaru</h3>
        {stats.recentAnalyses.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Belum ada analisa</p>
        ) : (
          <div className="divide-y">
            {stats.recentAnalyses.slice(0, 10).map((a) => (
              <div key={a.id} className="py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{a.contactName ?? a.contactPhone}</p>
                  <p className="text-xs text-muted-foreground">{formatRelative(a.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {scoreBadge(a.score)}
                  {a.enteredPipeline && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cutoff timeline */}
      {stats.cutoffTimeline.length > 0 && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h3 className="font-semibold text-sm">Timeline Jadwal Analisa</h3>
          <div className="space-y-2">
            {stats.cutoffTimeline.slice(0, 8).map((c, i) => {
              const isPending = !c.completedAt && c.scheduledTime != null && new Date(c.scheduledTime) > new Date();
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    c.status === "completed" ? "bg-green-500" :
                    c.status === "failed" ? "bg-red-500" :
                    c.status === "running" ? "bg-blue-500 animate-pulse" : "bg-muted-foreground/30"
                  )} />
                  <span className="text-xs text-muted-foreground flex-1">
                    {formatDate(c.scheduledTime)}
                  </span>
                  <span className={cn("text-xs capitalize", {
                    "text-green-600": c.status === "completed",
                    "text-red-600": c.status === "failed",
                    "text-blue-600": c.status === "running",
                    "text-muted-foreground": c.status === "pending",
                  })}>
                    {c.status}
                  </span>
                </div>
              );
            })}
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
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, (value / max)) * 100}%`, backgroundColor: color }}
        />
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
        <SheetHeader>
          <SheetTitle>Hasil Analisa AI</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-6">
          {/* Contact */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{analysis.contactName ?? analysis.contactPhone}</p>
              <p className="text-xs text-muted-foreground">{analysis.contactPhone}</p>
            </div>
            {scoreBadge(analysis.score)}
          </div>

          {/* Score breakdown */}
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

          {/* AI fields */}
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

function AnalysesTab({ pipelineId }: { pipelineId: number }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedAnalysis, setSelectedAnalysis] = useState<AiPipelineAnalysis | null>(null);

  const { data, isLoading } = useListAiPipelineAnalyses(pipelineId, {
    page,
    pageSize: 20,
  });

  const filtered = (data?.data ?? []).filter((a) =>
    !search ||
    a.contactPhone.includes(search) ||
    (a.contactName ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cari nomor/nama kontak..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <BrainCircuit className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Belum ada data analisa</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Kontak</th>
                  <th className="text-center px-4 py-2 text-xs font-medium text-muted-foreground">Skor</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground hidden md:table-cell">Pipeline</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground hidden md:table-cell">Waktu</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium">{a.contactName ?? a.contactPhone}</p>
                      <p className="text-xs text-muted-foreground">{a.contactPhone}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className="inline-flex items-center justify-center w-10 h-10 rounded-full text-white text-sm font-bold"
                        style={{ backgroundColor: scoreColor(a.score) }}
                      >
                        {a.score}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {a.enteredPipeline ? (
                        <span className="text-green-600 flex items-center gap-1 text-xs">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Masuk Pipeline
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Tidak masuk</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {formatRelative(a.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Button size="sm" variant="ghost" onClick={() => setSelectedAnalysis(a)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && data.total > 20 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{data.total} total</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span>{page} / {Math.ceil(data.total / 20)}</span>
                <Button size="sm" variant="outline" disabled={page >= Math.ceil(data.total / 20)} onClick={() => setPage(p => p + 1)}>
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

// ─── Entries Tab ───────────────────────────────────────────────────────────────

function EntryDrawer({ pipelineId, entryId, onClose }: { pipelineId: number; entryId: number | null; onClose: () => void }) {
  const { data: entry } = useGetAiPipelineEntry(pipelineId, entryId ?? 0, {
    query: {
      queryKey: getGetAiPipelineEntryQueryKey(pipelineId, entryId ?? 0),
      enabled: entryId != null,
    },
  });
  const qc = useQueryClient();
  const { toast } = useToast();

  const { mutate: doNotFollowup, isPending: blocking } = useDoNotFollowupAiPipelineEntry({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["listAiPipelineEntries", pipelineId] });
        toast({ title: "Follow-up dihentikan untuk kontak ini." });
        onClose();
      },
    },
  });

  if (!entryId || !entry) return null;

  return (
    <Sheet open={!!entryId} onOpenChange={() => onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Detail Pipeline Entry</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{entry.contactName ?? entry.contactPhone}</p>
              <p className="text-xs text-muted-foreground">{entry.contactPhone}</p>
            </div>
            {scoreBadge(entry.currentScore)}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <StatusBadge status={entry.status} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Follow-up Terkirim</p>
              <p className="font-medium">{entry.followupCount}x</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Follow-up Terakhir</p>
              <p className="text-sm">{formatRelative(entry.lastFollowupAt)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Follow-up Berikutnya</p>
              <p className="text-sm">{entry.nextFollowupAt ? formatDate(entry.nextFollowupAt) : "—"}</p>
            </div>
          </div>

          {entry.productInterest && (
            <div>
              <p className="text-xs text-muted-foreground">Produk Diminati</p>
              <p className="text-sm mt-0.5">{entry.productInterest}</p>
            </div>
          )}

          {/* Score history */}
          {entry.scoreHistory && entry.scoreHistory.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Riwayat Skor</p>
              <div className="space-y-1.5">
                {entry.scoreHistory.map((h: { score: number; date: string; cutoffWindow?: string }, i: number) => (
                  <div key={i} className="flex items-center gap-3">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{ backgroundColor: scoreColor(h.score) }}
                    >
                      {h.score}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {h.cutoffWindow && <span>{h.cutoffWindow} · </span>}
                      {formatDate(h.date)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Follow-up logs */}
          {entry.followupLogs && entry.followupLogs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Log Follow-up</p>
              <div className="space-y-3">
                {entry.followupLogs.map((log) => (
                  <div key={log.id} className="border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Follow-up #{log.followupNumber}</span>
                      <span>{formatRelative(log.sentAt)}</span>
                    </div>
                    <p className="text-sm">{log.messageSent}</p>
                    {log.wasReplied && (
                      <p className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Dibalas
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {entry.status !== "do_not_followup" && (
            <Button
              variant="outline"
              className="w-full text-destructive hover:text-destructive gap-2"
              onClick={() => doNotFollowup({ id: pipelineId, eid: entry.id, data: { reason: "Diblokir manual" } })}
              disabled={blocking}
            >
              {blocking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Hentikan Follow-up
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EntriesTab({ pipelineId }: { pipelineId: number }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);

  const { data, isLoading } = useListAiPipelineEntries(pipelineId, {
    page,
    pageSize: 20,
  });

  const filtered = (data?.data ?? []).filter((e) =>
    !search ||
    e.contactPhone.includes(search) ||
    (e.contactName ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Cari nomor/nama kontak..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Belum ada kontak di pipeline ini</p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Kontak</th>
                  <th className="text-center px-4 py-2 text-xs font-medium text-muted-foreground">Skor</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground hidden md:table-cell">Status</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground hidden md:table-cell">Follow-up</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium">{e.contactName ?? e.contactPhone}</p>
                      <p className="text-xs text-muted-foreground">{e.contactPhone}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className="inline-flex items-center justify-center w-10 h-10 rounded-full text-white text-sm font-bold"
                        style={{ backgroundColor: scoreColor(e.currentScore) }}
                      >
                        {e.currentScore}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <StatusBadge status={e.status} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {e.followupCount}x · {formatRelative(e.lastFollowupAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Button size="sm" variant="ghost" onClick={() => setSelectedEntryId(e.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && data.total > 20 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{data.total} total</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span>{page} / {Math.ceil(data.total / 20)}</span>
                <Button size="sm" variant="outline" disabled={page >= Math.ceil(data.total / 20)} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <EntryDrawer pipelineId={pipelineId} entryId={selectedEntryId} onClose={() => setSelectedEntryId(null)} />
    </div>
  );
}

// ─── Settings Tab ──────────────────────────────────────────────────────────────

const FOLLOWUP_PRESETS = [
  { label: "24 jam", value: "24h" },
  { label: "48 jam", value: "48h" },
  { label: "72 jam", value: "72h" },
  { label: "7 hari", value: "168h" },
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

function scoreColor2(val: number): string {
  if (val <= 40) return "#EF4444";
  if (val <= 60) return "#F59E0B";
  if (val <= 79) return "#3B82F6";
  return "#10B981";
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
  const [cutoffTimes, setCutoffTimes] = useState<string[]>(pipeline.cutoffTimes);
  const [scoreThreshold, setScoreThreshold] = useState(pipeline.scoreThreshold);
  const [autoCreateOpportunity, setAutoCreateOpportunity] = useState(pipeline.autoCreateOpportunity ?? false);
  const [opportunityThreshold, setOpportunityThreshold] = useState(pipeline.opportunityThreshold ?? 80);
  const [autoFollowupEnabled, setAutoFollowupEnabled] = useState(pipeline.autoFollowupEnabled ?? false);
  const [followupIntervals, setFollowupIntervals] = useState<string[]>(
    (pipeline.followupIntervals as string[] | null) ?? []
  );
  const [deleteOpen, setDeleteOpen] = useState(false);

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
        channelIds,
        excludeLabelIds,
        cutoffTimes: [...cutoffTimes].sort(),
        scoreThreshold,
        opportunityThreshold,
        autoCreateOpportunity,
        autoFollowupEnabled,
        followupIntervals: followupIntervals.slice(0, 3),
      },
    });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Basic */}
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

      {/* Channels */}
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
                channelIds.includes(c.id)
                  ? "border-primary bg-primary/10 text-primary"
                  : "hover:border-primary/50"
              )}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cutoff schedule */}
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

      {/* Score threshold */}
      <div className="space-y-3">
        <Label>Skor Minimum Pipeline: {scoreThreshold}</Label>
        <Slider min={0} max={100} step={1} value={[scoreThreshold]} onValueChange={([v]) => setScoreThreshold(v)} />
      </div>

      {/* Auto-opportunity */}
      <div className="space-y-3 border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <Label>Buat Opportunity Otomatis</Label>
          <Switch checked={autoCreateOpportunity} onCheckedChange={setAutoCreateOpportunity} />
        </div>
        {autoCreateOpportunity && (
          <div className="pt-2 border-t space-y-2">
            <Label className="text-sm">Skor Minimum: {Math.max(opportunityThreshold, scoreThreshold)}</Label>
            <Slider
              min={scoreThreshold}
              max={100}
              step={1}
              value={[Math.max(opportunityThreshold, scoreThreshold)]}
              onValueChange={([v]) => setOpportunityThreshold(v)}
            />
          </div>
        )}
      </div>

      {/* Auto follow-up */}
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

// ─── Main detail page ──────────────────────────────────────────────────────────

export default function AIPipelineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const pipelineId = Number(id);
  const [location, navigate] = useLocation();
  const qc = useQueryClient();
  const defaultTab = location.endsWith("/edit") ? "settings" : "dashboard";
  const { toast } = useToast();

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
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !pipeline) {
    return (
      <div className="p-6 max-w-5xl mx-auto flex flex-col items-center gap-3 mt-12">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="text-muted-foreground">Pipeline tidak ditemukan.</p>
        <Button variant="outline" onClick={() => navigate("/ai-pipeline")}>Kembali</Button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm text-muted-foreground flex items-center gap-1">
        <button onClick={() => navigate("/ai-pipeline")} className="hover:text-foreground">AI Pipeline</button>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-medium">{pipeline.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary/10">
            <BrainCircuit className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{pipeline.name}</h1>
            {pipeline.description && (
              <p className="text-sm text-muted-foreground">{pipeline.description}</p>
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

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runNow({ id: pipelineId })}
            disabled={running || !pipeline.isActive}
            className="gap-1.5"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Jalankan Sekarang
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

      {/* Tabs */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="analyses">Hasil Analisa</TabsTrigger>
          <TabsTrigger value="entries">Pipeline Entries</TabsTrigger>
          <TabsTrigger value="settings">Pengaturan</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardTab pipelineId={pipelineId} />
        </TabsContent>

        <TabsContent value="analyses" className="mt-4">
          <AnalysesTab pipelineId={pipelineId} />
        </TabsContent>

        <TabsContent value="entries" className="mt-4">
          <EntriesTab pipelineId={pipelineId} />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <SettingsTab pipeline={pipeline} onDeleted={() => navigate("/ai-pipeline")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
