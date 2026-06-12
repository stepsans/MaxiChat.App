import { useCallback, useEffect, useMemo, useState } from "react";
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
  useListPipelines,
  useCreatePipeline,
  useUpdatePipeline,
  useDeletePipeline,
  useListSalesStages,
  useCreateSalesStage,
  useUpdateSalesStage,
  useDeleteSalesStage,
  useReorderSalesStages,
  useListOpportunities,
  useUpdateOpportunity,
  useGetPipelineHealth,
  useListAgents,
  useGetSalesForecast,
  useListSalesAuditEvents,
  useGetSalesAssistantSettings,
  useUpdateSalesAssistantSettings,
  getListPipelinesQueryKey,
  getListSalesStagesQueryKey,
  getListOpportunitiesQueryKey,
  getGetPipelineHealthQueryKey,
  getListAgentsQueryKey,
  getGetSalesForecastQueryKey,
  getListSalesAuditEventsQueryKey,
  getGetSalesAssistantSettingsQueryKey,
  type Pipeline,
  type SalesStage,
  type Opportunity,
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
  ShieldAlert,
  Trash2,
  TrendingUp,
  LayoutGrid,
  BarChart3,
  History,
  Settings2,
  ChevronDown,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import OpportunityDetailDialog from "@/components/OpportunityDetailDialog";

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

function avatarColor(name: string): string {
  const palette = ["#6366f1", "#8b5cf6", "#ec4899", "#14b8a6", "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#f97316", "#0ea5e9"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
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
type ViewMode = "board" | "analytics" | "activity";

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
  const [view, setView] = useState<ViewMode>("board");
  const [activePipelineId, setActivePipelineId] = useState<number | null>(null);
  const [pipelineMgmtOpen, setPipelineMgmtOpen] = useState(false);
  const [stageMgmtPipelineId, setStageMgmtPipelineId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [riskSettingsOpen, setRiskSettingsOpen] = useState(false);

  const enabled = hasEntitlement && perm.canView;

  const { data: pipelines, isLoading: pipelinesLoading } = useListPipelines({
    query: {
      queryKey: getListPipelinesQueryKey(),
      enabled,
    },
  });

  // Select first non-archived pipeline by default once data arrives.
  const activePipeline = useMemo(() => {
    if (!pipelines || pipelines.length === 0) return null;
    if (activePipelineId != null) {
      const found = pipelines.find((p) => p.id === activePipelineId && !p.isArchived);
      if (found) return found;
    }
    return pipelines.find((p) => !p.isArchived) ?? null;
  }, [pipelines, activePipelineId]);

  const { data: stages, isLoading: stagesLoading } = useListSalesStages(
    activePipeline ? { pipelineId: activePipeline.id } : undefined,
    {
      query: {
        queryKey: getListSalesStagesQueryKey(
          activePipeline ? { pipelineId: activePipeline.id } : undefined
        ),
        enabled: enabled && activePipeline != null,
      },
    }
  );

  const { data: opportunities, isLoading: oppsLoading } = useListOpportunities(
    {
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      ...(activePipeline ? { pipelineId: activePipeline.id } : {}),
    },
    {
      query: {
        queryKey: getListOpportunitiesQueryKey({
          ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          ...(activePipeline ? { pipelineId: activePipeline.id } : {}),
        }),
        enabled: enabled && activePipeline != null,
        refetchInterval: 15_000,
      },
    }
  );

  const { data: health } = useGetPipelineHealth({
    query: {
      queryKey: getGetPipelineHealthQueryKey(),
      enabled,
      refetchInterval: 30_000,
    },
  });

  const { data: team } = useListAgents({
    query: { queryKey: getListAgentsQueryKey(), enabled },
  });

  const { data: forecast, isLoading: forecastLoading } = useGetSalesForecast({
    query: {
      queryKey: getGetSalesForecastQueryKey(),
      enabled: enabled && view === "analytics",
      refetchInterval: 30_000,
    },
  });

  const { data: auditEvents, isLoading: auditLoading } = useListSalesAuditEvents(
    { limit: 100 },
    {
      query: {
        queryKey: getListSalesAuditEventsQueryKey({ limit: 100 }),
        enabled: enabled && view === "activity",
        refetchInterval: 30_000,
      },
    }
  );

  const updateOpp = useUpdateOpportunity();

  const { data: riskSettings } = useGetSalesAssistantSettings({
    query: {
      queryKey: getGetSalesAssistantSettingsQueryKey(),
      enabled: enabled && perm.canEdit,
    },
  });
  const updateRiskSettings = useUpdateSalesAssistantSettings({
    mutation: {
      onSuccess: (data) => {
        qc.setQueryData(getGetSalesAssistantSettingsQueryKey(), data);
        qc.invalidateQueries({ queryKey: getGetPipelineHealthQueryKey() });
        setRiskSettingsOpen(false);
        toast({ description: "Setelan risiko disimpan." });
      },
      onError: () => {
        toast({ variant: "destructive", description: "Gagal menyimpan setelan risiko." });
      },
    },
  });

  const [staleDraft, setStaleDraft] = useState("");
  const [highValueDraft, setHighValueDraft] = useState("");

  useEffect(() => {
    if (riskSettings && riskSettingsOpen) {
      setStaleDraft(String(riskSettings.staleDaysThreshold));
      setHighValueDraft(String(riskSettings.highValueThresholdIdr));
    }
  }, [riskSettings, riskSettingsOpen]);

  function submitRiskSettings() {
    const stale = Number(staleDraft);
    const highValue = Number(highValueDraft);
    if (!Number.isInteger(stale) || stale < 1 || stale > 365) {
      toast({ variant: "destructive", description: "Hari tidak aktif harus bilangan bulat 1–365." });
      return;
    }
    if (!Number.isInteger(highValue) || highValue < 0) {
      toast({ variant: "destructive", description: "Nilai minimum harus bilangan bulat ≥ 0." });
      return;
    }
    updateRiskSettings.mutate({ data: { staleDaysThreshold: stale, highValueThresholdIdr: highValue } });
  }

  const highRiskIds = useMemo(
    () => new Set(health?.highRiskIds ?? []),
    [health]
  );

  const sortedStages = useMemo(
    () => [...(stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [stages]
  );

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const invalidateBoard = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/sales/opportunities"] });
    qc.invalidateQueries({ queryKey: getGetPipelineHealthQueryKey() });
  }, [qc]);

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
    const target = sortedStages.find((s) => s.id === newStageId);
    const nextStatus = target?.isWon ? "won" : target?.isLost ? "lost" : "open";
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

  const loading = pipelinesLoading || stagesLoading || oppsLoading;
  const summary = health?.summary;
  const visiblePipelines = (pipelines ?? []).filter((p) => !p.isArchived);

  return (
    <>
    <div className="flex flex-col h-full">
      {/* Header */}
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
            <SelectTrigger className="w-[130px]" data-testid="select-status-filter">
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
              data-testid="button-risk-settings"
              onClick={() => setRiskSettingsOpen(true)}
            >
              <ShieldAlert className="w-4 h-4 mr-1.5" />
              Setelan Risiko
            </Button>
          ) : null}
          {perm.canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="button-pipeline-options">
                  <Settings2 className="w-4 h-4 mr-1.5" />
                  Kelola
                  <ChevronDown className="w-3.5 h-3.5 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {activePipeline ? (
                  <>
                    <DropdownMenuItem
                      onClick={() => setStageMgmtPipelineId(activePipeline.id)}
                      data-testid="menu-manage-stages"
                    >
                      <Pencil className="w-4 h-4 mr-2" />
                      Kelola Stage ({activePipeline.name})
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  onClick={() => setPipelineMgmtOpen(true)}
                  data-testid="menu-manage-pipelines"
                >
                  <Settings2 className="w-4 h-4 mr-2" />
                  Kelola Pipeline
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {/* Pipeline tabs */}
      {visiblePipelines.length > 1 ? (
        <div className="flex items-center gap-0.5 px-4 border-b sm:px-6 overflow-x-auto">
          {visiblePipelines.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setActivePipelineId(p.id)}
              data-testid={`tab-pipeline-${p.id}`}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors shrink-0",
                activePipeline?.id === p.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: p.color }}
              />
              {p.name}
            </button>
          ))}
        </div>
      ) : null}

      {/* View tabs */}
      <div className="flex items-center gap-1 px-4 border-b sm:px-6">
        {(
          [
            { key: "board" as const, label: "Papan", icon: LayoutGrid },
            { key: "analytics" as const, label: "Analitik", icon: BarChart3 },
            { key: "activity" as const, label: "Aktivitas", icon: History },
          ]
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
                <strong>{formatRupiah(summary.highRiskValueIdr)}</strong> butuh perhatian.
              </span>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : !activePipeline ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-2 text-sm text-muted-foreground">
              <p>Belum ada pipeline. Buat pipeline pertama Anda.</p>
              {perm.canEdit ? (
                <Button size="sm" onClick={() => setPipelineMgmtOpen(true)}>
                  <Plus className="w-4 h-4 mr-1.5" />
                  Buat Pipeline
                </Button>
              ) : null}
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
                    ...sortedStages.map((s) => ({ key: String(s.id), stage: s as SalesStage | null })),
                    { key: NO_STAGE, stage: null as SalesStage | null },
                  ].map(({ key, stage }) => {
                    const items = byStage.get(key) ?? [];
                    const total = items.reduce((sum, o) => sum + o.estimatedValueIdr, 0);
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
                            agents={team?.agents ?? []}
                          />
                        ))}
                        {items.length === 0 ? (
                          <p className="px-1 py-6 text-xs text-center text-muted-foreground">Kosong</p>
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
                    agents={team?.agents ?? []}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </>
      ) : null}

      {view === "analytics" ? (
        <ForecastPanel forecast={forecast} loading={forecastLoading} />
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

      {pipelineMgmtOpen ? (
        <PipelineManagerDialog
          pipelines={pipelines ?? []}
          onClose={() => setPipelineMgmtOpen(false)}
        />
      ) : null}

      {stageMgmtPipelineId != null ? (
        <StageManagerDialog
          pipeline={pipelines?.find((p) => p.id === stageMgmtPipelineId) ?? null}
          stages={sortedStages}
          onClose={() => setStageMgmtPipelineId(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StageColumn
// ---------------------------------------------------------------------------

function StageColumn({
  id, title, color, isTerminal, count, total, canDrag, children,
}: {
  id: string; title: string; color: string | null; isTerminal: boolean;
  count: number; total: number; canDrag: boolean; children: React.ReactNode;
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
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Terminal</Badge>
        ) : null}
        <Badge variant="outline" className="ml-auto text-[10px]">{count}</Badge>
      </div>
      <div className="px-3 py-1 text-[11px] text-muted-foreground border-b">
        {formatRupiah(total)}
      </div>
      <div className="flex flex-col flex-1 gap-2 p-2 overflow-y-auto">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpportunityCard
// ---------------------------------------------------------------------------

function OpportunityCard({
  opp, highRisk, canDrag, dragging, onClick, agents,
}: {
  opp: Opportunity; highRisk: boolean; canDrag: boolean;
  dragging?: boolean; onClick?: () => void;
  agents?: Array<{ id: number; name?: string | null; email: string }>;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opp.id,
    disabled: !canDrag,
  });
  const band = scoreBand(opp.leadScore);
  const displayName = opp.contactName || opp.contactPhone;
  const bgColor = avatarColor(displayName);
  const assignee = opp.assignedUserId != null
    ? (agents ?? []).find((a) => a.id === opp.assignedUserId)
    : null;
  const assigneeName = assignee ? (assignee.name ?? assignee.email) : null;

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
          {/* Contact info row with profile pic */}
          <div className="flex items-center gap-1.5">
            {opp.profilePicUrl ? (
              <img
                src={opp.profilePicUrl}
                alt=""
                className="w-6 h-6 rounded-full shrink-0 object-cover"
              />
            ) : (
              <div
                className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
                style={{ background: bgColor }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-sm font-medium truncate flex-1 min-w-0">
              {displayName}
            </span>
            {highRisk ? (
              <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
            ) : null}
          </div>
          {opp.contactName ? (
            <div className="text-[11px] text-muted-foreground truncate ml-[30px]">
              {opp.contactPhone}
            </div>
          ) : null}

          {/* Channel badge */}
          {opp.channelLabel ? (
            <div className="flex items-center gap-1 mt-1 ml-[30px]">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: opp.channelColor ?? "#25D366" }}
              />
              <span className="text-[10px] text-muted-foreground truncate">
                {opp.channelLabel}
              </span>
            </div>
          ) : null}

          <div className="mt-1.5 text-sm font-semibold ml-[30px]">
            {formatRupiah(opp.estimatedValueIdr)}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 ml-[30px] flex-wrap">
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
            {opp.waitingStatus === "waiting_customer" ? (
              <span className="rounded bg-orange-100 text-orange-700 px-1.5 py-0.5 text-[10px] font-medium">
                ⏳ Perlu FU
              </span>
            ) : null}
          </div>

          {/* Products */}
          {opp.products && opp.products.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1.5 ml-[30px]">
              {opp.products.slice(0, 3).map((p, i) => (
                <span
                  key={i}
                  className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] truncate max-w-[120px]"
                >
                  {p.productName}
                </span>
              ))}
              {opp.products.length > 3 ? (
                <span className="text-[10px] text-muted-foreground">
                  +{opp.products.length - 3}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Footer: last activity + assignee */}
          <div className="flex items-center justify-between mt-1.5 ml-[30px]">
            <span className="text-[10px] text-muted-foreground">
              {timeAgo(opp.lastActivityAt)}
            </span>
            {assigneeName ? (
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                style={{ background: avatarColor(assigneeName) }}
                title={assigneeName}
              >
                {assigneeName.charAt(0).toUpperCase()}
              </div>
            ) : null}
          </div>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineManagerDialog
// ---------------------------------------------------------------------------

function PipelineManagerDialog({
  pipelines,
  onClose,
}: {
  pipelines: Pipeline[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreatePipeline();
  const update = useUpdatePipeline();
  const del = useDeletePipeline();

  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Pipeline | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListPipelinesQueryKey() });

  function addPipeline() {
    const name = newName.trim();
    if (!name) {
      toast({ title: "Nama pipeline wajib diisi", variant: "destructive" });
      return;
    }
    create.mutate(
      { data: { name } },
      {
        onSuccess: () => {
          setNewName("");
          invalidate();
          toast({ title: "Pipeline ditambahkan." });
        },
        onError: (err: any) =>
          toast({
            title: "Gagal menambah pipeline",
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
    update.mutate(
      { id: editId, data: { name } },
      {
        onSuccess: () => { setEditId(null); invalidate(); },
        onError: (err: any) =>
          toast({ title: "Gagal mengubah nama", description: err?.message ?? "Coba lagi.", variant: "destructive" }),
      }
    );
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(
      { id: pendingDelete.id },
      {
        onSuccess: () => { setPendingDelete(null); invalidate(); toast({ title: "Pipeline diarsipkan." }); },
        onError: (err: any) => {
          setPendingDelete(null);
          toast({
            title: "Gagal menghapus pipeline",
            description: err?.status === 409
              ? "Pipeline masih memiliki peluang aktif. Pindahkan atau tutup dulu."
              : err?.message ?? "Coba lagi.",
            variant: "destructive",
          });
        },
      }
    );
  }

  const visible = pipelines.filter((p) => !p.isArchived);
  const archived = pipelines.filter((p) => p.isArchived);

  return (
    <>
      <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Kelola Pipeline</DialogTitle>
            <DialogDescription>
              Tambah, ubah nama, atau arsipkan pipeline.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {visible.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 p-2 border rounded-md"
                data-testid={`pipeline-row-${p.id}`}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: p.color }}
                />
                {editId === p.id ? (
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveRename()}
                    autoFocus
                    className="h-8"
                  />
                ) : (
                  <span className="flex-1 text-sm truncate">{p.name}</span>
                )}
                {p.isDefault ? (
                  <Badge variant="secondary" className="text-[10px] shrink-0">Default</Badge>
                ) : null}
                {p.pipelineType !== "custom" ? (
                  <Badge variant="outline" className="text-[10px] shrink-0">{p.pipelineType}</Badge>
                ) : null}
                {editId === p.id ? (
                  <Button size="sm" onClick={saveRename} className="h-8 shrink-0">Simpan</Button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => { setEditId(p.id); setEditName(p.name); }}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      aria-label="Ubah nama"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    {!p.isDefault ? (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(p)}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        aria-label="Arsipkan"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ))}

            {archived.length > 0 ? (
              <p className="text-xs text-muted-foreground pt-1">
                {archived.length} pipeline diarsipkan
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPipeline()}
              placeholder="Nama pipeline baru"
              className="flex-1 h-9"
            />
            <Button
              onClick={addPipeline}
              disabled={create.isPending || !newName.trim()}
              size="sm"
            >
              {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arsipkan pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              Pipeline <strong>{pendingDelete?.name}</strong> akan diarsipkan. Peluang yang sudah ditutup tetap tersimpan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Arsipkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// StageManagerDialog
// ---------------------------------------------------------------------------

function StageManagerDialog({
  pipeline,
  stages,
  onClose,
}: {
  pipeline: Pipeline | null;
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

  const invalidate = () => {
    if (pipeline) {
      qc.invalidateQueries({ queryKey: getListSalesStagesQueryKey({ pipelineId: pipeline.id }) });
    }
    qc.invalidateQueries({ queryKey: getListPipelinesQueryKey() });
  };

  function addStage() {
    if (!pipeline) return;
    const name = newName.trim();
    if (!name) {
      toast({ title: "Nama stage wajib diisi", variant: "destructive" });
      return;
    }
    create.mutate(
      { data: { pipelineId: pipeline.id, name, sortOrder: stages.length } },
      {
        onSuccess: () => { setNewName(""); invalidate(); toast({ title: "Stage ditambahkan." }); },
        onError: (err: any) =>
          toast({ title: "Gagal menambah stage", description: err?.message ?? "Coba lagi.", variant: "destructive" }),
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
        onSuccess: () => { setEditId(null); invalidate(); },
        onError: (err: any) =>
          toast({ title: "Gagal mengubah nama", description: err?.message ?? "Coba lagi.", variant: "destructive" }),
      }
    );
  }

  function move(index: number, dir: -1 | 1) {
    if (!pipeline) return;
    const next = [...stages];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(
      { data: { pipelineId: pipeline.id, stageIds: next.map((s) => s.id) } },
      {
        onSuccess: () => invalidate(),
        onError: (err: any) =>
          toast({ title: "Gagal mengurutkan", description: err?.message ?? "Coba lagi.", variant: "destructive" }),
      }
    );
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteStage.mutate(
      { id: pendingDelete.id },
      {
        onSuccess: () => { setPendingDelete(null); invalidate(); toast({ title: "Stage dihapus." }); },
        onError: (err: any) => {
          setPendingDelete(null);
          toast({
            title: "Gagal menghapus stage",
            description: err?.status === 409
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
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Kelola Stage — {pipeline?.name}</DialogTitle>
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
                    aria-label="Naik"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={i === stages.length - 1 || reorder.isPending}
                    onClick={() => move(i, 1)}
                    className="text-muted-foreground disabled:opacity-30"
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
                  <Button size="sm" onClick={saveRename} className="h-8">Simpan</Button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => { setEditId(s.id); setEditName(s.name); }}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Ubah nama"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(s)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Hapus"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            ))}
            {stages.length === 0 ? (
              <p className="py-4 text-sm text-center text-muted-foreground">Belum ada stage.</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addStage()}
              placeholder="Nama stage baru"
              className="flex-1 h-9"
            />
            <Button
              onClick={addStage}
              disabled={create.isPending || !newName.trim()}
              size="sm"
            >
              {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus stage?</AlertDialogTitle>
            <AlertDialogDescription>
              Stage <strong>{pendingDelete?.name}</strong> akan dihapus permanen. Peluang di stage ini akan menjadi tanpa stage.
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

// ---------------------------------------------------------------------------
// ForecastPanel
// ---------------------------------------------------------------------------

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="p-4 border rounded-lg bg-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ForecastPanel({ forecast, loading }: { forecast: SalesForecast | undefined; loading: boolean }) {
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
    Nilai: Number(s.valueIdr),
    Tertimbang: Number(s.weightedIdr),
  }));

  const totalOpen = forecast.openCount;
  const funnelData = forecast.byStage
    .filter((s) => s.count > 0)
    .map((s) => ({
      name: s.stageName,
      count: s.count,
      pct: totalOpen > 0 ? Math.round((s.count / totalOpen) * 100) : 0,
    }));

  const closedTotal = forecast.wonCount + forecast.lostCount;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6 sm:p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Pipeline</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Nilai pipeline terbuka" value={formatRupiah(Number(forecast.openValueIdr))} hint={`${forecast.openCount} peluang terbuka`} />
          <MetricCard label="Prakiraan tertimbang" value={formatRupiah(Number(forecast.weightedForecastIdr))} hint="Nilai × skor lead" />
          <MetricCard label="Rata-rata ukuran deal" value={formatRupiah(Number(forecast.avgDealSizeIdr))} hint="Rata-rata nilai peluang terbuka" />
          <MetricCard label="Sales velocity" value={Number(forecast.salesVelocityIdr) > 0 ? `${formatRupiah(Number(forecast.salesVelocityIdr))}/hari` : "—"} hint="Pendapatan yang dihasilkan per hari" />
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Performa</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Tingkat kemenangan" value={`${forecast.winRatePct}%`} hint={`${forecast.wonCount} menang · ${forecast.lostCount} kalah`} />
          <MetricCard label="Nilai dimenangkan" value={formatRupiah(Number(forecast.wonValueIdr))} hint={`${forecast.wonCount} deal tertutup`} />
          <MetricCard label="Rata-rata siklus deal" value={forecast.avgCycleDays > 0 ? `${forecast.avgCycleDays} hari` : "—"} hint={closedTotal > 0 ? `Dari ${closedTotal} deal tertutup` : "Belum ada deal tertutup"} />
          <MetricCard label="Total deal tertutup" value={String(closedTotal)} hint={`${forecast.wonCount} menang · ${forecast.lostCount} kalah`} />
        </div>
      </div>
      <div className="p-4 border rounded-lg bg-card">
        <h2 className="text-sm font-semibold">Prakiraan per Stage</h2>
        <p className="mb-4 text-xs text-muted-foreground">Nilai terbuka vs prakiraan tertimbang (nilai × skor lead) per stage.</p>
        {chartData.length === 0 ? (
          <p className="py-12 text-sm text-center text-muted-foreground">Belum ada peluang terbuka.</p>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={(v) => new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v))} />
                <Tooltip formatter={(v: number | string, name: string) => [formatRupiah(Number(v)), name]} contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="Nilai" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Tertimbang" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {funnelData.length > 0 && (
        <div className="p-4 border rounded-lg bg-card">
          <h2 className="text-sm font-semibold">Distribusi Pipeline</h2>
          <p className="mb-4 text-xs text-muted-foreground">Jumlah peluang terbuka di tiap stage.</p>
          <div className="space-y-2">
            {funnelData.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-32 truncate shrink-0">{s.name}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-primary transition-all duration-300" style={{ width: `${s.pct}%` }} />
                </div>
                <span className="text-xs font-mono w-14 text-right shrink-0">{s.count} deal</span>
                <span className="text-xs text-muted-foreground w-8 text-right shrink-0">{s.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditTrailPanel
// ---------------------------------------------------------------------------

const AUDIT_EVENT_LABEL: Record<string, string> = {
  opportunity_created: "Peluang dibuat",
  opportunity_deleted: "Peluang dihapus",
  stage_changed: "Stage diubah",
  stage_recommendation: "Rekomendasi stage",
  follow_up_recommended: "Tindak lanjut disarankan",
  follow_up_sent: "Tindak lanjut dikirim",
  lead_scored: "Skor lead diperbarui",
  opportunity_upserted: "Peluang dideteksi AI",
};

const AUDIT_EVENT_CATEGORIES: Record<string, { label: string; color: string }> = {
  opportunity_created:   { label: "Dibuat", color: "bg-emerald-500" },
  opportunity_upserted:  { label: "AI Detect", color: "bg-violet-500" },
  opportunity_deleted:   { label: "Dihapus", color: "bg-red-500" },
  stage_changed:         { label: "Stage", color: "bg-blue-500" },
  stage_recommendation:  { label: "Rekomendasi", color: "bg-primary" },
  follow_up_recommended: { label: "Follow-up", color: "bg-amber-500" },
  follow_up_sent:        { label: "Follow-up", color: "bg-amber-500" },
  lead_scored:           { label: "Skor", color: "bg-violet-500" },
};

function AuditTrailPanel({ events, loading }: { events: SalesAuditEvent[] | undefined; loading: boolean }) {
  const [filterType, setFilterType] = useState<string>("all");

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

  const eventTypes = Array.from(new Set(events.map((e) => e.eventType))).sort();
  const filtered = filterType === "all" ? events : events.filter((e) => e.eventType === filterType);
  const aiCount = events.filter((e) => e.actorUserId == null).length;
  const userCount = events.length - aiCount;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b sm:px-6">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2">
          <span className="font-medium text-foreground">{events.length}</span> aktivitas
          <span className="mx-1">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />{aiCount} AI
          </span>
          <span className="mx-1">·</span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{userCount} pengguna
          </span>
        </div>
        <div className="flex flex-wrap gap-1 ml-auto">
          <button
            type="button"
            onClick={() => setFilterType("all")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium border transition-colors",
              filterType === "all" ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border hover:bg-muted"
            )}
          >
            Semua
          </button>
          {eventTypes.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilterType(t)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium border transition-colors",
                filterType === t ? "bg-foreground text-background border-foreground" : "bg-background text-muted-foreground border-border hover:bg-muted"
              )}
            >
              {AUDIT_EVENT_CATEGORIES[t]?.label ?? t}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {filtered.length === 0 ? (
          <p className="py-8 text-sm text-center text-muted-foreground">Tidak ada aktivitas dengan filter ini.</p>
        ) : (
          <ul className="space-y-2 max-w-3xl">
            {filtered.map((ev) => {
              const cat = AUDIT_EVENT_CATEGORIES[ev.eventType];
              const isAi = ev.actorUserId == null;
              const detail = Object.entries(ev.detail ?? {})
                .filter(([, v]) => v != null && typeof v !== "object")
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join(" · ");
              return (
                <li key={ev.id} className="flex items-start gap-3 p-3 border rounded-lg bg-card">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", cat?.color ?? (isAi ? "bg-primary" : "bg-emerald-500"))} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium">{AUDIT_EVENT_LABEL[ev.eventType] ?? ev.eventType}</span>
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", isAi ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
                        {isAi ? "AI / sistem" : "Pengguna"}
                      </span>
                    </div>
                    {detail ? <p className="mt-0.5 text-xs text-muted-foreground break-words">{detail}</p> : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">{new Date(ev.createdAt).toLocaleString("id-ID")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>

      {/* Risk Settings Dialog */}
      <Dialog open={riskSettingsOpen} onOpenChange={setRiskSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              Setelan Risiko
            </DialogTitle>
            <DialogDescription>
              Peluang terbuka yang memenuhi kedua kriteria di bawah akan
              ditandai sebagai berisiko tinggi.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="risk-stale-days">Tidak aktif selama (hari)</Label>
              <Input
                id="risk-stale-days"
                type="number"
                min={1}
                max={365}
                value={staleDraft}
                onChange={(e) => setStaleDraft(e.target.value)}
                placeholder="14"
                data-testid="input-risk-stale-days"
              />
              <p className="text-xs text-muted-foreground">
                Peluang yang belum ada aktivitas ≥ N hari dianggap stagnan.
                Rentang: 1–365.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="risk-high-value">Nilai minimum (Rupiah)</Label>
              <Input
                id="risk-high-value"
                type="number"
                min={0}
                step={1000}
                value={highValueDraft}
                onChange={(e) => setHighValueDraft(e.target.value)}
                placeholder="0"
                data-testid="input-risk-high-value"
              />
              <p className="text-xs text-muted-foreground">
                Hanya peluang dengan estimasi nilai ≥ angka ini yang masuk
                hitungan. Isi <strong>0</strong> agar semua nilai ikut
                terdeteksi.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRiskSettingsOpen(false)}
              disabled={updateRiskSettings.isPending}
            >
              Batal
            </Button>
            <Button
              onClick={submitRiskSettings}
              disabled={updateRiskSettings.isPending}
              data-testid="button-risk-settings-save"
            >
              {updateRiskSettings.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : null}
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
