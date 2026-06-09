import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  useGetMe,
  useListSalesStages,
  useListOpportunities,
  useUpdateOpportunity,
  useCreateSalesStage,
  useUpdateSalesStage,
  useDeleteSalesStage,
  useReorderSalesStages,
  useGetPipelineHealth,
  useListAgents,
  useGetSalesForecast,
  useListSalesAuditEvents,
  getListSalesStagesQueryKey,
  getListOpportunitiesQueryKey,
  getGetPipelineHealthQueryKey,
  getListAgentsQueryKey,
  getGetSalesForecastQueryKey,
  getListSalesAuditEventsQueryKey,
  type Opportunity,
  type SalesStage,
  type SalesAuditEvent,
  type SalesForecast,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
  TrendingUp,
  LayoutGrid,
  BarChart3,
  History,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";

// Sentinel id for the synthetic "Tanpa Stage" column (opportunities with a
// null stageId). dnd-kit needs string ids; we map this back to null on drop.
const NO_STAGE = "no-stage";

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

function scoreBand(score: number): { label: string; className: string } {
  if (score >= 70)
    return { label: "Tinggi", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
  if (score >= 40)
    return { label: "Sedang", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  return { label: "Rendah", className: "bg-muted text-muted-foreground" };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Belum ada aktivitas";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Hari ini";
  if (days === 1) return "1 hari lalu";
  if (days < 30) return `${days} hari lalu`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 bulan lalu";
  return `${months} bulan lalu`;
}

type StatusFilter = "open" | "won" | "lost" | "all";

const STATUS_LABEL: Record<string, string> = {
  open: "Terbuka",
  won: "Menang",
  lost: "Kalah",
};

export default function Pipeline() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { menus, isLoading: permsLoading } = usePermissions();
  const perm = menus.opportunities;

  const { data: me, isLoading: meLoading } = useGetMe({
    query: { queryKey: ["/api/auth/me"] },
  });
  const hasEntitlement = me?.user?.hasAiSalesAssistant === true;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [view, setView] = useState<"board" | "analytics" | "activity">("board");

  const { data: stages, isLoading: stagesLoading } = useListSalesStages({
    query: { queryKey: getListSalesStagesQueryKey(), enabled: hasEntitlement && perm.canView },
  });
  const { data: opportunities, isLoading: oppsLoading } = useListOpportunities(
    statusFilter === "all" ? {} : { status: statusFilter },
    {
      query: {
        queryKey: getListOpportunitiesQueryKey(
          statusFilter === "all" ? undefined : { status: statusFilter }
        ),
        enabled: hasEntitlement && perm.canView,
        refetchInterval: 15_000,
      },
    }
  );
  const { data: health } = useGetPipelineHealth({
    query: {
      queryKey: getGetPipelineHealthQueryKey(),
      enabled: hasEntitlement && perm.canView,
      refetchInterval: 30_000,
    },
  });
  const { data: team } = useListAgents({
    query: {
      queryKey: getListAgentsQueryKey(),
      enabled: hasEntitlement && perm.canView,
    },
  });

  // Analytics + activity surfaces are lazy: only fetched once their tab is
  // opened (the board is the default view).
  const { data: forecast, isLoading: forecastLoading } = useGetSalesForecast({
    query: {
      queryKey: getGetSalesForecastQueryKey(),
      enabled: hasEntitlement && perm.canView && view === "analytics",
      refetchInterval: 30_000,
    },
  });
  const { data: auditEvents, isLoading: auditLoading } = useListSalesAuditEvents(
    { limit: 100 },
    {
      query: {
        queryKey: getListSalesAuditEventsQueryKey({ limit: 100 }),
        enabled: hasEntitlement && perm.canView && view === "activity",
        refetchInterval: 30_000,
      },
    }
  );

  const updateOpp = useUpdateOpportunity();

  const highRiskIds = useMemo(
    () => new Set(health?.highRiskIds ?? []),
    [health]
  );

  const [activeId, setActiveId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [stageMgmtOpen, setStageMgmtOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const sortedStages = useMemo(
    () => [...(stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [stages]
  );

  // Group opportunities by stage id (or NO_STAGE). Only "open" deals respect
  // the per-stage layout; won/lost are terminal and live in their stage too.
  const byStage = useMemo(() => {
    const map = new Map<string, Opportunity[]>();
    map.set(NO_STAGE, []);
    for (const s of sortedStages) map.set(String(s.id), []);
    for (const o of opportunities ?? []) {
      const key = o.stageId == null ? NO_STAGE : String(o.stageId);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    return map;
  }, [sortedStages, opportunities]);

  const activeOpp = useMemo(
    () => (opportunities ?? []).find((o) => o.id === activeId) ?? null,
    [opportunities, activeId]
  );
  const detailOpp = useMemo(
    () => (opportunities ?? []).find((o) => o.id === detailId) ?? null,
    [opportunities, detailId]
  );

  const invalidateBoard = () => {
    qc.invalidateQueries({ queryKey: ["/api/sales/opportunities"] });
    qc.invalidateQueries({ queryKey: getGetPipelineHealthQueryKey() });
  };

  function handleDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const oppId = Number(active.id);
    const opp = (opportunities ?? []).find((o) => o.id === oppId);
    if (!opp) return;
    const overKey = String(over.id);
    const newStageId = overKey === NO_STAGE ? null : Number(overKey);
    if ((opp.stageId ?? null) === newStageId) return;

    // Moving onto a terminal stage flips lifecycle status to match.
    const target = sortedStages.find((s) => s.id === newStageId);
    const nextStatus = target?.isWon
      ? "won"
      : target?.isLost
        ? "lost"
        : "open";

    updateOpp.mutate(
      { id: oppId, data: { stageId: newStageId, status: nextStatus } },
      {
        onSuccess: () => invalidateBoard(),
        onError: (err: any) => {
          invalidateBoard();
          toast({
            title: "Gagal memindahkan",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          });
        },
      }
    );
  }

  if (meLoading || permsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!hasEntitlement) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <Lock className="w-8 h-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">AI Sales Assistant</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Fitur ini tersedia pada paket Enterprise. Hubungi admin untuk
          mengaktifkan AI Sales Assistant pada akun Anda.
        </p>
      </div>
    );
  }

  if (!perm.canView) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <Lock className="w-8 h-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Akses dibatasi</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Anda tidak memiliki izin untuk melihat AI Sales Assistant.
        </p>
      </div>
    );
  }

  const loading = stagesLoading || oppsLoading;
  const summary = health?.summary;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b sm:px-6">
        <div>
          <h1 className="text-lg font-semibold">AI Sales Assistant</h1>
          <p className="text-xs text-muted-foreground">
            Kelola pipeline penjualan dan peluang Anda.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-[150px]" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Terbuka</SelectItem>
              <SelectItem value="won">Menang</SelectItem>
              <SelectItem value="lost">Kalah</SelectItem>
              <SelectItem value="all">Semua</SelectItem>
            </SelectContent>
          </Select>
          {perm.canEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStageMgmtOpen(true)}
              data-testid="button-manage-stages"
            >
              <Pencil className="w-4 h-4 mr-1.5" />
              Kelola Stage
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1 px-4 border-b sm:px-6">
        {(
          [
            { key: "board", label: "Papan", icon: LayoutGrid },
            { key: "analytics", label: "Analitik", icon: BarChart3 },
            { key: "activity", label: "Aktivitas", icon: History },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            data-testid={`tab-${key}`}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
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

      {view === "board" ? (
        <>
          {summary && summary.highRiskCount > 0 ? (
            <div className="flex items-center gap-2 px-4 py-2.5 text-sm border-b bg-destructive/10 text-destructive sm:px-6">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                <strong>{summary.highRiskCount}</strong> peluang berisiko tinggi
                (tidak aktif &ge; {summary.staleDaysThreshold} hari) senilai{" "}
                <strong>{formatRupiah(summary.highRiskValueIdr)}</strong> butuh
                perhatian.
              </span>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="flex-1 overflow-x-auto">
                <div className="flex h-full gap-3 p-4 sm:p-6 min-w-max">
                  {[
                    ...sortedStages.map((s) => ({
                      key: String(s.id),
                      stage: s,
                    })),
                    { key: NO_STAGE, stage: null as SalesStage | null },
                  ].map(({ key, stage }) => {
                    const items = byStage.get(key) ?? [];
                    const total = items.reduce(
                      (sum, o) => sum + o.estimatedValueIdr,
                      0
                    );
                    return (
                      <StageColumn
                        key={key}
                        id={key}
                        title={stage?.name ?? "Tanpa Stage"}
                        color={stage?.color ?? null}
                        isTerminal={!!(stage?.isWon || stage?.isLost)}
                        count={items.length}
                        total={total}
                        canDrag={perm.canEdit}
                      >
                        {items.map((o) => (
                          <OpportunityCard
                            key={o.id}
                            opp={o}
                            highRisk={highRiskIds.has(o.id)}
                            canDrag={perm.canEdit}
                            onClick={() => setDetailId(o.id)}
                          />
                        ))}
                        {items.length === 0 ? (
                          <p className="px-1 py-6 text-xs text-center text-muted-foreground">
                            Kosong
                          </p>
                        ) : null}
                      </StageColumn>
                    );
                  })}
                </div>
              </div>
              <DragOverlay>
                {activeOpp ? (
                  <OpportunityCard
                    opp={activeOpp}
                    highRisk={highRiskIds.has(activeOpp.id)}
                    canDrag
                    dragging
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </>
      ) : null}

      {view === "analytics" ? (
        <ForecastPanel
          forecast={forecast}
          loading={forecastLoading}
        />
      ) : null}

      {view === "activity" ? (
        <AuditTrailPanel events={auditEvents} loading={auditLoading} />
      ) : null}

      {detailOpp ? (
        <OpportunityDetailDialog
          key={detailOpp.id}
          opp={detailOpp}
          stages={sortedStages}
          agents={team?.agents ?? []}
          canEdit={perm.canEdit}
          onClose={() => setDetailId(null)}
          onSaved={() => {
            invalidateBoard();
            setDetailId(null);
          }}
        />
      ) : null}

      {stageMgmtOpen ? (
        <StageManagerDialog
          stages={sortedStages}
          onClose={() => setStageMgmtOpen(false)}
        />
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="p-4 border rounded-lg bg-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ForecastPanel({
  forecast,
  loading,
}: {
  forecast: SalesForecast | undefined;
  loading: boolean;
}) {
  if (loading && !forecast) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!forecast) {
    return (
      <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
        Belum ada data prakiraan.
      </div>
    );
  }

  const chartData = forecast.byStage.map((s) => ({
    name: s.stageName,
    Nilai: s.valueIdr,
    Tertimbang: s.weightedIdr,
  }));

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6 sm:p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Nilai pipeline terbuka"
          value={formatRupiah(forecast.openValueIdr)}
          hint={`${forecast.openCount} peluang terbuka`}
        />
        <MetricCard
          label="Prakiraan tertimbang"
          value={formatRupiah(forecast.weightedForecastIdr)}
          hint="Nilai × skor lead"
        />
        <MetricCard
          label="Tingkat kemenangan"
          value={`${forecast.winRatePct}%`}
          hint={`${forecast.wonCount} menang · ${forecast.lostCount} kalah`}
        />
        <MetricCard
          label="Nilai dimenangkan"
          value={formatRupiah(forecast.wonValueIdr)}
          hint="Total peluang menang"
        />
      </div>

      <div className="p-4 border rounded-lg bg-card">
        <h2 className="text-sm font-semibold">Prakiraan per Stage</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Nilai terbuka dan prakiraan tertimbang di tiap stage.
        </p>
        {chartData.length === 0 ? (
          <p className="py-12 text-sm text-center text-muted-foreground">
            Belum ada peluang terbuka.
          </p>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-muted"
                  vertical={false}
                />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                  tickFormatter={(v) =>
                    new Intl.NumberFormat("id-ID", {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(Number(v))
                  }
                />
                <Tooltip
                  formatter={(v: number | string) => formatRupiah(Number(v))}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar
                  dataKey="Nilai"
                  fill="hsl(var(--muted-foreground))"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="Tertimbang"
                  fill="hsl(var(--primary))"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

const AUDIT_EVENT_LABEL: Record<string, string> = {
  opportunity_created: "Peluang dibuat",
  opportunity_deleted: "Peluang dihapus",
  stage_changed: "Stage diubah",
  stage_recommendation: "Rekomendasi stage",
  follow_up_recommended: "Tindak lanjut disarankan",
  follow_up_sent: "Tindak lanjut dikirim",
  lead_scored: "Skor lead diperbarui",
};

function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABEL[eventType] ?? eventType;
}

function auditDetailText(ev: SalesAuditEvent): string | null {
  const d = ev.detail ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    if (typeof v === "object") continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function AuditTrailPanel({
  events,
  loading,
}: {
  events: SalesAuditEvent[] | undefined;
  loading: boolean;
}) {
  if (loading && !events) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
        Belum ada aktivitas tercatat.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <ul className="space-y-2 max-w-3xl">
        {events.map((ev) => {
          const detail = auditDetailText(ev);
          return (
            <li
              key={ev.id}
              className="flex items-start gap-3 p-3 border rounded-lg bg-card"
              data-testid={`audit-event-${ev.id}`}
            >
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  ev.actorUserId == null ? "bg-primary" : "bg-emerald-500"
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium">
                    {auditEventLabel(ev.eventType)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ev.actorUserId == null ? "AI / sistem" : "Pengguna"}
                  </span>
                </div>
                {detail ? (
                  <p className="mt-0.5 text-xs text-muted-foreground break-words">
                    {detail}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(ev.createdAt).toLocaleString("id-ID")}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StageColumn({
  id,
  title,
  color,
  isTerminal,
  count,
  total,
  canDrag,
  children,
}: {
  id: string;
  title: string;
  color: string | null;
  isTerminal: boolean;
  count: number;
  total: number;
  canDrag: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !canDrag });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col w-72 shrink-0 rounded-lg border bg-muted/30",
        isOver && canDrag && "ring-2 ring-primary"
      )}
      data-testid={`column-${id}`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: color ?? "hsl(var(--muted-foreground))" }}
        />
        <span className="text-sm font-medium truncate">{title}</span>
        {isTerminal ? (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            Terminal
          </Badge>
        ) : null}
        <Badge variant="outline" className="ml-auto text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="px-3 py-1 text-[11px] text-muted-foreground border-b">
        {formatRupiah(total)}
      </div>
      <div className="flex flex-col flex-1 gap-2 p-2 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function OpportunityCard({
  opp,
  highRisk,
  canDrag,
  dragging,
  onClick,
}: {
  opp: Opportunity;
  highRisk: boolean;
  canDrag: boolean;
  dragging?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opp.id,
    disabled: !canDrag,
  });
  const band = scoreBand(opp.leadScore);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border bg-background p-2.5 shadow-sm",
        (isDragging || dragging) && "opacity-60",
        highRisk && "border-destructive/60"
      )}
      data-testid={`card-opportunity-${opp.id}`}
    >
      <div className="flex items-start gap-1.5">
        {canDrag ? (
          <button
            type="button"
            className="mt-0.5 cursor-grab text-muted-foreground touch-none active:cursor-grabbing"
            {...attributes}
            {...listeners}
            data-testid={`drag-handle-${opp.id}`}
            aria-label="Pindahkan"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : null}
        <button
          type="button"
          className="flex-1 min-w-0 text-left"
          onClick={onClick}
          data-testid={`button-open-opportunity-${opp.id}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">
              {opp.contactName || opp.contactPhone}
            </span>
            {highRisk ? (
              <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
            ) : null}
          </div>
          {opp.contactName ? (
            <div className="text-[11px] text-muted-foreground truncate">
              {opp.contactPhone}
            </div>
          ) : null}
          <div className="mt-1.5 text-sm font-semibold">
            {formatRupiah(opp.estimatedValueIdr)}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                band.className
              )}
            >
              <TrendingUp className="w-3 h-3" />
              {opp.leadScore} · {band.label}
            </span>
            {opp.intentCategory ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground truncate">
                {opp.intentCategory}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {timeAgo(opp.lastActivityAt)}
          </div>
        </button>
      </div>
    </div>
  );
}

function OpportunityDetailDialog({
  opp,
  stages,
  agents,
  canEdit,
  onClose,
  onSaved,
}: {
  opp: Opportunity;
  stages: SalesStage[];
  agents: { id: number; name: string | null; email: string }[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateOpportunity();

  const [stageId, setStageId] = useState<string>(
    opp.stageId == null ? NO_STAGE : String(opp.stageId)
  );
  const [assignee, setAssignee] = useState<string>(
    opp.assignedUserId == null ? "none" : String(opp.assignedUserId)
  );
  const [status, setStatus] = useState<string>(opp.status);
  const [contactName, setContactName] = useState(opp.contactName ?? "");
  const [value, setValue] = useState(String(opp.estimatedValueIdr));
  const [intent, setIntent] = useState(opp.intentCategory ?? "");
  const [waiting, setWaiting] = useState(opp.waitingStatus ?? "");
  const [products, setProducts] = useState(opp.productInterest.join(", "));

  function save() {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 0) {
      toast({ title: "Nilai estimasi tidak valid", variant: "destructive" });
      return;
    }
    update.mutate(
      {
        id: opp.id,
        data: {
          stageId: stageId === NO_STAGE ? null : Number(stageId),
          assignedUserId: assignee === "none" ? null : Number(assignee),
          status: status as "open" | "won" | "lost",
          contactName: contactName.trim() || null,
          estimatedValueIdr: v,
          intentCategory: intent.trim() || null,
          waitingStatus: waiting.trim() || null,
          productInterest: products
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Peluang diperbarui." });
          onSaved();
        },
        onError: (err: any) =>
          toast({
            title: "Gagal menyimpan",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          }),
      }
    );
  }

  const band = scoreBand(opp.leadScore);

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{opp.contactName || opp.contactPhone}</DialogTitle>
          <DialogDescription>{opp.contactPhone}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium",
                band.className
              )}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Skor AI {opp.leadScore} · {band.label}
            </span>
            <span className="text-[11px] text-muted-foreground">
              (otomatis, hanya-baca)
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Stage</Label>
              <Select value={stageId} onValueChange={setStageId} disabled={!canEdit}>
                <SelectTrigger data-testid="select-detail-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_STAGE}>Tanpa Stage</SelectItem>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus} disabled={!canEdit}>
                <SelectTrigger data-testid="select-detail-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Terbuka</SelectItem>
                  <SelectItem value="won">Menang</SelectItem>
                  <SelectItem value="lost">Kalah</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Penanggung jawab</Label>
            <Select value={assignee} onValueChange={setAssignee} disabled={!canEdit}>
              <SelectTrigger data-testid="select-detail-assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Belum ditugaskan</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name || a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="opp-name">Nama kontak</Label>
              <Input
                id="opp-name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                disabled={!canEdit}
                data-testid="input-detail-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opp-value">Estimasi nilai (Rp)</Label>
              <Input
                id="opp-value"
                type="number"
                min={0}
                step={1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!canEdit}
                data-testid="input-detail-value"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="opp-intent">Kategori minat</Label>
              <Input
                id="opp-intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                disabled={!canEdit}
                data-testid="input-detail-intent"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opp-waiting">Status tunggu</Label>
              <Input
                id="opp-waiting"
                value={waiting}
                onChange={(e) => setWaiting(e.target.value)}
                disabled={!canEdit}
                data-testid="input-detail-waiting"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="opp-products">Minat produk (pisahkan koma)</Label>
            <Input
              id="opp-products"
              value={products}
              onChange={(e) => setProducts(e.target.value)}
              disabled={!canEdit}
              data-testid="input-detail-products"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Catatan AI (hanya-baca)</Label>
            <Textarea
              value={opp.aiNotes ?? ""}
              readOnly
              rows={3}
              className="resize-none bg-muted/40"
              placeholder="Belum ada catatan AI."
              data-testid="text-detail-ainotes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Tutup
          </Button>
          {canEdit ? (
            <Button
              onClick={save}
              disabled={update.isPending}
              data-testid="button-save-opportunity"
            >
              {update.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : null}
              Simpan
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageManagerDialog({
  stages,
  onClose,
}: {
  stages: SalesStage[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreateSalesStage();
  const updateStage = useUpdateSalesStage();
  const deleteStage = useDeleteSalesStage();
  const reorder = useReorderSalesStages();

  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SalesStage | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListSalesStagesQueryKey() });

  function addStage() {
    const name = newName.trim();
    if (!name) {
      toast({ title: "Nama stage wajib diisi", variant: "destructive" });
      return;
    }
    create.mutate(
      { data: { name, sortOrder: stages.length } },
      {
        onSuccess: () => {
          setNewName("");
          invalidate();
          toast({ title: "Stage ditambahkan." });
        },
        onError: (err: any) =>
          toast({
            title: "Gagal menambah stage",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          }),
      }
    );
  }

  function saveRename() {
    if (editId == null) return;
    const name = editName.trim();
    if (!name) return;
    updateStage.mutate(
      { id: editId, data: { name } },
      {
        onSuccess: () => {
          setEditId(null);
          invalidate();
        },
        onError: (err: any) =>
          toast({
            title: "Gagal mengubah nama",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          }),
      }
    );
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...stages];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(
      { data: { stageIds: next.map((s) => s.id) } },
      {
        onSuccess: () => invalidate(),
        onError: (err: any) =>
          toast({
            title: "Gagal mengurutkan",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          }),
      }
    );
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteStage.mutate(
      { id: pendingDelete.id },
      {
        onSuccess: () => {
          setPendingDelete(null);
          invalidate();
          toast({ title: "Stage dihapus." });
        },
        onError: (err: any) => {
          setPendingDelete(null);
          toast({
            title: "Gagal menghapus stage",
            description:
              err?.status === 409
                ? "Masih ada peluang yang memakai stage ini. Pindahkan dulu."
                : err?.message ?? "Coba lagi.",
            variant: "destructive",
          });
        },
      }
    );
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kelola Stage</DialogTitle>
            <DialogDescription>
              Tambah, ubah nama, urutkan, atau hapus stage pipeline.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {stages.map((s, i) => (
              <div
                key={s.id}
                className="flex items-center gap-2 p-2 border rounded-md"
                data-testid={`stage-row-${s.id}`}
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    disabled={i === 0 || reorder.isPending}
                    onClick={() => move(i, -1)}
                    className="text-muted-foreground disabled:opacity-30"
                    data-testid={`button-stage-up-${s.id}`}
                    aria-label="Naik"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={i === stages.length - 1 || reorder.isPending}
                    onClick={() => move(i, 1)}
                    className="text-muted-foreground disabled:opacity-30"
                    data-testid={`button-stage-down-${s.id}`}
                    aria-label="Turun"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                {editId === s.id ? (
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveRename()}
                    autoFocus
                    className="h-8"
                    data-testid={`input-rename-${s.id}`}
                  />
                ) : (
                  <span className="flex-1 text-sm truncate">{s.name}</span>
                )}
                {(s.isWon || s.isLost) && editId !== s.id ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {s.isWon ? "Menang" : "Kalah"}
                  </Badge>
                ) : null}
                {editId === s.id ? (
                  <Button size="sm" onClick={saveRename} className="h-8">
                    Simpan
                  </Button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(s.id);
                        setEditName(s.name);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      data-testid={`button-rename-${s.id}`}
                      aria-label="Ubah nama"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(s)}
                      className="text-muted-foreground hover:text-destructive"
                      data-testid={`button-delete-stage-${s.id}`}
                      aria-label="Hapus"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
            {stages.length === 0 ? (
              <p className="py-4 text-sm text-center text-muted-foreground">
                Belum ada stage.
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addStage()}
              placeholder="Nama stage baru"
              data-testid="input-new-stage"
            />
            <Button
              onClick={addStage}
              disabled={create.isPending}
              data-testid="button-add-stage"
            >
              <Plus className="w-4 h-4 mr-1" />
              Tambah
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Selesai
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(o) => (!o ? setPendingDelete(null) : undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus stage?</AlertDialogTitle>
            <AlertDialogDescription>
              Stage "{pendingDelete?.name}" akan dihapus. Stage yang masih
              dipakai peluang tidak bisa dihapus.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
