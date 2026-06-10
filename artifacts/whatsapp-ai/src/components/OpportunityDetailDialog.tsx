import { useState, useRef, useMemo, useEffect } from "react";
import {
  useUpdateOpportunity,
  useListOpportunityFollowUps,
  useSendOpportunityFollowUp,
  useUpdateOpportunityFollowUp,
  useListSalesAuditEvents,
  getListOpportunityFollowUpsQueryKey,
  getListSalesAuditEventsQueryKey,
  type Opportunity,
  type SalesStage,
  type OpportunityFollowUp,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  Package,
  Cpu,
  ChevronRight,
  Clock,
  Send,
  X,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Lightbulb,
  Brain,
  Phone,
  Copy,
  ExternalLink,
  Image,
  Upload,
  ZoomIn,
  Download,
  Calendar,
  Activity,
  ThumbsUp,
  ThumbsDown,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type AgentLike = { id: number; name?: string | null; email: string };

interface Props {
  opp: Opportunity;
  stages: SalesStage[];
  agents: AgentLike[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const WAITING_STATUS_LABEL: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  waiting_customer: { label: "Menunggu balasan customer", color: "text-orange-600 bg-orange-50 border-orange-200", icon: Clock },
  waiting_company: { label: "Menunggu balasan Anda", color: "text-blue-600 bg-blue-50 border-blue-200", icon: MessageSquare },
};

const FOLLOWUP_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending: { label: "Menunggu Pengiriman", color: "text-blue-600 bg-blue-50" },
  sent: { label: "Terkirim", color: "text-green-600 bg-green-50" },
  cancelled: { label: "Dibatalkan", color: "text-muted-foreground bg-muted" },
  skipped: { label: "Dilewati", color: "text-muted-foreground bg-muted" },
};

const ACTIVITY_LABEL: Record<string, string> = {
  lead_scored: "Skor lead diperbarui",
  opportunity_created: "Opportunity dibuat",
  opportunity_updated: "Opportunity diperbarui",
  stage_changed: "Stage dipindahkan",
  follow_up_generated: "Follow-up dijenerasikan",
  follow_up_sent: "Follow-up terkirim",
  follow_up_cancelled: "Follow-up dibatalkan",
  message_received: "Pesan masuk",
  message_sent: "Pesan terkirim",
};

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Baru saja";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

function scoreBand(score: number): { label: string; className: string; color: string } {
  if (score >= 70) return { label: "Tinggi", className: "text-emerald-600 dark:text-emerald-400", color: "#10B981" };
  if (score >= 40) return { label: "Sedang", className: "text-amber-600 dark:text-amber-400", color: "#F59E0B" };
  return { label: "Rendah", className: "text-muted-foreground", color: "#6B7280" };
}

function avatarColor(name: string): string {
  const palette = ["#6366f1", "#8b5cf6", "#ec4899", "#14b8a6", "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#f97316", "#0ea5e9"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

// ─── Score Gauge ─────────────────────────────────────────────────────────────

function ScoreGauge({ score }: { score: number }) {
  const radius = 42;
  const stroke = 9;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dashOffset = circumference * (1 - pct);
  const { color, label } = scoreBand(score);

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="108" height="108" viewBox="0 0 108 108">
        <circle cx="54" cy="54" r={radius} fill="none" stroke="currentColor"
          className="text-muted/40" strokeWidth={stroke} />
        <circle cx="54" cy="54" r={radius} fill="none" stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 54 54)"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
        <text x="54" y="51" textAnchor="middle" fill={color}
          fontSize="24" fontWeight="bold" fontFamily="inherit">{score}</text>
        <text x="54" y="66" textAnchor="middle" fill="currentColor"
          fontSize="11" className="fill-muted-foreground" fontFamily="inherit">/100</text>
      </svg>
      <span className={cn("text-xs font-semibold", scoreBand(score).className)}>{label}</span>
    </div>
  );
}

type Tab = "detail" | "signals" | "screenshot" | "followup";
type Screenshot = { id: string; url: string; caption: string; file: File };

export default function OpportunityDetailDialog({
  opp, stages, agents, canEdit, onClose, onSaved,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const update = useUpdateOpportunity();

  const [tab, setTab] = useState<Tab>("detail");
  const [stageId, setStageId] = useState<string>(
    opp.stageId == null ? "__none__" : String(opp.stageId)
  );
  const [status, setStatus] = useState(opp.status ?? "open");
  const [value, setValue] = useState(String(opp.estimatedValueIdr ?? 0));
  const [notes, setNotes] = useState(opp.aiNotes ?? "");
  const [assignedUserId, setAssignedUserId] = useState<string>(
    opp.assignedUserId == null ? "__unassigned" : String(opp.assignedUserId)
  );

  // Screenshot local state
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [captionEdit, setCaptionEdit] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Follow-up template
  const [template, setTemplate] = useState("");
  const templateInit = useRef(false);

  const dirty =
    stageId !== (opp.stageId == null ? "__none__" : String(opp.stageId)) ||
    status !== (opp.status ?? "open") ||
    value !== String(opp.estimatedValueIdr ?? 0) ||
    notes !== (opp.aiNotes ?? "") ||
    assignedUserId !== (opp.assignedUserId == null ? "__unassigned" : String(opp.assignedUserId));

  // Audit events
  const { data: auditEvents } = useListSalesAuditEvents(
    { opportunityId: opp.id, limit: 20 },
    { query: { queryKey: getListSalesAuditEventsQueryKey({ opportunityId: opp.id, limit: 20 }) } }
  );

  // Follow-ups
  const { data: followUps, isLoading: fuLoading } = useListOpportunityFollowUps(opp.id, {
    query: {
      queryKey: getListOpportunityFollowUpsQueryKey(opp.id),
      enabled: tab === "followup",
    },
  });

  const { mutate: sendFollowUp, isPending: sending } = useSendOpportunityFollowUp({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListOpportunityFollowUpsQueryKey(opp.id) });
        toast({ title: "Follow-up dikirim." });
      },
      onError: (err: any) =>
        toast({ title: "Gagal mengirim follow-up", description: err?.message, variant: "destructive" }),
    },
  });

  const { mutate: cancelFollowUp, isPending: cancelling } = useUpdateOpportunityFollowUp({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListOpportunityFollowUpsQueryKey(opp.id) });
        toast({ title: "Follow-up dibatalkan." });
      },
    },
  });

  // Derived data
  const waitingInfo = opp.waitingStatus ? WAITING_STATUS_LABEL[opp.waitingStatus] : null;

  const rawKeyQuotes = opp.keyQuotes as any;
  const positiveSignals: string[] = useMemo(() => {
    if (!rawKeyQuotes) return [];
    if (Array.isArray(rawKeyQuotes)) return rawKeyQuotes;
    return (rawKeyQuotes.positive ?? rawKeyQuotes.reasons ?? []) as string[];
  }, [rawKeyQuotes]);
  const negativeSignals: string[] = useMemo(() => {
    if (!rawKeyQuotes || Array.isArray(rawKeyQuotes)) return [];
    return (rawKeyQuotes.negative ?? rawKeyQuotes.barriers ?? []) as string[];
  }, [rawKeyQuotes]);

  const scoreHistory = useMemo(() => {
    const events = (auditEvents ?? [])
      .filter((e) => e.eventType === "lead_scored")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const points = events.map((e) => ({
      label: new Date(e.createdAt).toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
      score: (e.detail as any)?.score ?? (e.detail as any)?.leadScore ?? opp.leadScore,
    }));
    const currentLabel = opp.analyzedAt
      ? new Date(opp.analyzedAt).toLocaleDateString("id-ID", { day: "2-digit", month: "short" })
      : "Sekarang";
    if (points.length === 0) return [{ label: currentLabel, score: opp.leadScore }];
    const last = points[points.length - 1];
    if (last.score !== opp.leadScore) points.push({ label: currentLabel, score: opp.leadScore });
    return points;
  }, [auditEvents, opp]);

  const activityLog = useMemo(() => {
    return (auditEvents ?? [])
      .slice(0, 5)
      .map((e) => ({
        id: e.id,
        label: ACTIVITY_LABEL[e.eventType] ?? e.eventType.replace(/_/g, " "),
        time: e.createdAt,
        type: e.eventType,
      }));
  }, [auditEvents]);

  const pendingFU = useMemo(() => (followUps ?? []).filter((fu) => fu.status === "pending"), [followUps]);
  const sentFU = useMemo(() => (followUps ?? []).filter((fu) => fu.status === "sent"), [followUps]);
  const firstPending = pendingFU[0] ?? null;
  const lastSent = sentFU.length > 0 ? sentFU[sentFU.length - 1] : null;

  const aiTemplate = firstPending?.generatedMessage ?? opp.recommendation ?? null;

  useEffect(() => {
    if (!templateInit.current && aiTemplate) {
      templateInit.current = true;
      setTemplate(aiTemplate);
    }
  }, [aiTemplate]);

  const waPhone = opp.contactPhone.replace(/[^0-9]/g, "").replace(/^0/, "62");
  const waLink = template.trim()
    ? `https://wa.me/${waPhone}?text=${encodeURIComponent(template.trim())}`
    : `https://wa.me/${waPhone}`;

  function handleSave() {
    const parsedValue = Math.max(0, Math.floor(Number(value) || 0));
    const parsedStageId = stageId === "__none__" ? null : Number(stageId);
    const parsedAssignee = assignedUserId === "__unassigned" ? null : Number(assignedUserId);
    update.mutate(
      { id: opp.id, data: { stageId: parsedStageId, status, estimatedValueIdr: parsedValue, aiNotes: notes.trim() || null, assignedUserId: parsedAssignee } },
      {
        onSuccess: () => { toast({ title: "Opportunity diperbarui." }); onSaved(); },
        onError: (err: any) => toast({ title: "Gagal menyimpan", description: err?.message, variant: "destructive" }),
      }
    );
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const newScreenshots: Screenshot[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${Math.random()}`,
      url: URL.createObjectURL(file),
      caption: "",
      file,
    }));
    setScreenshots((prev) => [...prev, ...newScreenshots]);
    e.target.value = "";
  }

  function removeScreenshot(id: string) {
    setScreenshots((prev) => {
      const s = prev.find((x) => x.id === id);
      if (s) URL.revokeObjectURL(s.url);
      return prev.filter((x) => x.id !== id);
    });
  }

  function saveCaption(id: string) {
    setScreenshots((prev) => prev.map((s) => s.id === id ? { ...s, caption: captionEdit } : s));
    setEditingId(null);
  }

  function copyPhone() {
    navigator.clipboard.writeText(opp.contactPhone);
    toast({ title: "Nomor disalin." });
  }

  const displayName = opp.contactName || opp.contactPhone;
  const initials = displayName.charAt(0).toUpperCase();
  const bgColor = avatarColor(displayName);

  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: "detail", label: "Detail" },
    { key: "signals", label: "Sinyal AI" },
    { key: "screenshot", label: "Screenshot", badge: screenshots.length || undefined },
    { key: "followup", label: "Follow Up", badge: pendingFU.length || undefined },
  ];

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
          {/* ── Header ── */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b pr-12 shrink-0">
            {opp.profilePicUrl ? (
              <img src={opp.profilePicUrl} alt="" className="w-11 h-11 rounded-full object-cover shrink-0" />
            ) : (
              <div
                className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-sm font-bold text-white"
                style={{ background: bgColor }}
              >
                {initials}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold leading-snug truncate">{displayName}</h2>
              {opp.contactName ? (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">{opp.contactPhone}</span>
                  <button type="button" onClick={copyPhone} className="text-muted-foreground hover:text-foreground" title="Salin nomor">
                    <Copy className="w-3 h-3" />
                  </button>
                  <a href={`https://wa.me/${waPhone}`} target="_blank" rel="noopener noreferrer"
                    className="text-green-600 hover:text-green-700" title="Buka WhatsApp">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-0.5">
                  <button type="button" onClick={copyPhone} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
                    <Copy className="w-3 h-3" />Salin
                  </button>
                  <a href={`https://wa.me/${waPhone}`} target="_blank" rel="noopener noreferrer"
                    className="text-green-600 hover:text-green-700 flex items-center gap-1 text-xs">
                    <ExternalLink className="w-3 h-3" />WA
                  </a>
                </div>
              )}
              {opp.channelLabel ? (
                <div className="flex items-center gap-1 mt-1">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: opp.channelColor ?? "#25D366" }} />
                  <span className="text-[11px] text-muted-foreground">{opp.channelLabel}</span>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <span className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold bg-muted/40",
                scoreBand(opp.leadScore).className
              )}>
                <TrendingUp className="w-3.5 h-3.5" />
                {opp.leadScore}
              </span>
              {waitingInfo ? (
                <div className={cn(
                  "flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium",
                  waitingInfo.color
                )}>
                  <waitingInfo.icon className="w-3 h-3" />
                  {waitingInfo.label}
                </div>
              ) : null}
            </div>
          </div>

          {/* ── Tabs ── */}
          <div className="flex border-b px-5 shrink-0 overflow-x-auto">
            {tabs.map(({ key, label, badge }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0",
                  tab === key
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
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
                {/* Contact card */}
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground text-xs">Nomor:</span>
                    <span className="font-mono text-xs">{opp.contactPhone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground text-xs">Dibuat:</span>
                    <span className="text-xs">{formatDate(opp.createdAt)}</span>
                  </div>
                  {(opp.pipelineName || opp.stageName) ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Cpu className="w-3.5 h-3.5 shrink-0" />
                      <span>{opp.pipelineName ?? "Pipeline"}</span>
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                      <span>{opp.stageName ?? "Tanpa Stage"}</span>
                    </div>
                  ) : null}
                </div>

                {/* Editable fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Stage</Label>
                    {canEdit ? (
                      <Select value={stageId} onValueChange={setStageId}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue placeholder="Pilih stage…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Tanpa Stage</SelectItem>
                          {stages.map((s) => (
                            <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm">{opp.stageName ?? "Tanpa Stage"}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Status</Label>
                    {canEdit ? (
                      <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">Terbuka</SelectItem>
                          <SelectItem value="won">Menang</SelectItem>
                          <SelectItem value="lost">Kalah</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm capitalize">{status}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Estimasi Nilai (IDR)</Label>
                  {canEdit ? (
                    <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} className="h-9 text-xs" />
                  ) : (
                    <p className="text-sm font-semibold">{formatRupiah(opp.estimatedValueIdr)}</p>
                  )}
                </div>

                {agents.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Ditugaskan ke</Label>
                    {canEdit ? (
                      <Select value={assignedUserId} onValueChange={setAssignedUserId}>
                        <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Belum di-assign" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unassigned">Belum di-assign</SelectItem>
                          {agents.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>{a.name ?? a.email}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm">
                        {opp.assignedUserId
                          ? agents.find((a) => a.id === opp.assignedUserId)?.name ?? agents.find((a) => a.id === opp.assignedUserId)?.email ?? "—"
                          : "Belum di-assign"}
                      </p>
                    )}
                  </div>
                ) : null}

                {/* Product interest */}
                {opp.productInterest && opp.productInterest.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Package className="w-3 h-3" />Minat Produk
                    </Label>
                    <div className="flex flex-wrap gap-1.5">
                      {opp.productInterest.map((p, i) => (
                        <Badge key={i} variant="secondary" className="text-xs font-normal">{p}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Products from catalog */}
                {opp.products && opp.products.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Package className="w-3 h-3" />Produk
                    </Label>
                    <div className="flex flex-wrap gap-1.5">
                      {opp.products.map((p, i) => (
                        <Badge key={i} variant="secondary" className="text-xs font-normal">{p.productName}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {canEdit ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Catatan</Label>
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                      placeholder="Catatan internal…" className="text-xs min-h-[72px]" />
                  </div>
                ) : opp.aiNotes ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">Catatan AI</Label>
                    <p className="text-xs">{opp.aiNotes}</p>
                  </div>
                ) : null}

                {/* Activity log */}
                {activityLog.length > 0 ? (
                  <div className="space-y-2 pt-1 border-t">
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Activity className="w-3.5 h-3.5" />Aktivitas Terkini
                    </div>
                    <div className="space-y-2">
                      {activityLog.map((ev) => (
                        <div key={ev.id} className="flex items-start gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 mt-1.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs">{ev.label}</p>
                            <p className="text-[10px] text-muted-foreground">{timeAgo(ev.time)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Metadata */}
                <div className="grid grid-cols-2 gap-3 pt-1 border-t text-xs">
                  {opp.intentCategory ? (
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kategori</p>
                      <p>{opp.intentCategory}</p>
                    </div>
                  ) : null}
                  {opp.intentType ? (
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Tipe</p>
                      <p>{opp.intentType}</p>
                    </div>
                  ) : null}
                  {opp.lastActivityAt ? (
                    <div className="col-span-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Aktivitas terakhir</p>
                      <p>{formatDate(opp.lastActivityAt)}</p>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* ── Tab: Sinyal AI ── */}
            {tab === "signals" ? (
              <div className="space-y-5">
                {/* Score card */}
                <div className="flex items-center gap-6 p-4 rounded-xl border bg-muted/20">
                  <ScoreGauge score={opp.leadScore} />
                  <div className="flex-1 min-w-0 space-y-2">
                    {waitingInfo ? (
                      <div className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium w-fit",
                        waitingInfo.color
                      )}>
                        <waitingInfo.icon className="w-3.5 h-3.5" />
                        {waitingInfo.label}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Intent:</span>{" "}
                      {opp.intentCategory ?? opp.intentKey ?? "—"}
                    </div>
                    {opp.estimatedValueIdr > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Estimasi:</span>{" "}
                        {formatRupiah(opp.estimatedValueIdr)}
                      </div>
                    ) : null}
                    {opp.analyzedAt ? (
                      <div className="text-[10px] text-muted-foreground">
                        Dianalisa {formatDate(opp.analyzedAt)}
                        {opp.analyzedMessageIds?.length ? ` · ${opp.analyzedMessageIds.length} pesan` : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Score history chart */}
                {scoreHistory.length > 1 ? (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Riwayat Skor</p>
                    <div className="h-28">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={scoreHistory} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                          <defs>
                            <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={scoreBand(opp.leadScore).color} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={scoreBand(opp.leadScore).color} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                          <Tooltip
                            contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                            formatter={(v: number) => [`Skor: ${v}`, ""]}
                          />
                          <Area
                            type="monotone"
                            dataKey="score"
                            stroke={scoreBand(opp.leadScore).color}
                            fill="url(#scoreGrad)"
                            strokeWidth={2}
                            dot={{ r: 3, fill: scoreBand(opp.leadScore).color }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ) : null}

                {/* Positive signals */}
                {positiveSignals.length > 0 || negativeSignals.length > 0 ? (
                  <div className={cn(
                    "grid gap-4",
                    negativeSignals.length > 0 ? "grid-cols-2" : "grid-cols-1"
                  )}>
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                        <ThumbsUp className="w-3.5 h-3.5" />Faktor Positif
                      </div>
                      {positiveSignals.length > 0 ? (
                        <ul className="space-y-1.5">
                          {positiveSignals.map((q, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs">
                              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                              <span>{q}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Tidak ada sinyal positif.</p>
                      )}
                    </div>
                    {negativeSignals.length > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-600">
                          <ThumbsDown className="w-3.5 h-3.5" />Faktor Negatif
                        </div>
                        <ul className="space-y-1.5">
                          {negativeSignals.map((q, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs">
                              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                              <span>{q}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Product interest */}
                {opp.productInterest && opp.productInterest.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Package className="w-3.5 h-3.5" />Minat Produk
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {opp.productInterest.map((p, i) => (
                        <span key={i} className="rounded-full bg-primary/10 text-primary px-2.5 py-1 text-xs font-medium">{p}</span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Recommendation */}
                {opp.recommendation ? (
                  <div className="rounded-lg border bg-primary/5 p-3 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                      <Lightbulb className="w-3.5 h-3.5" />Rekomendasi AI
                    </div>
                    <p className="text-sm">{opp.recommendation}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs mt-1"
                      onClick={() => { setTemplate(opp.recommendation ?? ""); setTab("followup"); }}
                    >
                      <Send className="w-3 h-3 mr-1" />Gunakan untuk Follow Up
                    </Button>
                  </div>
                ) : null}

                {/* AI Notes */}
                {opp.aiNotes ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Brain className="w-3.5 h-3.5" />Catatan AI
                    </div>
                    <p className="text-sm text-foreground leading-relaxed">{opp.aiNotes}</p>
                  </div>
                ) : null}

                {/* Score reason */}
                {opp.scoreReason ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Alasan skor {opp.leadScore}
                    </p>
                    <p className="text-xs text-foreground leading-relaxed">{opp.scoreReason}</p>
                  </div>
                ) : null}

                {!opp.recommendation && !opp.scoreReason && positiveSignals.length === 0 && !opp.aiNotes ? (
                  <div className="py-10 text-center">
                    <Brain className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                    <p className="text-sm text-muted-foreground">Belum ada sinyal AI. Jalankan analisa dari percakapan.</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* ── Tab: Screenshot ── */}
            {tab === "screenshot" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {screenshots.length === 0 ? "Belum ada screenshot." : `${screenshots.length} screenshot`}
                  </p>
                  <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
                    onClick={() => fileInputRef.current?.click()}>
                    <Upload className="w-3.5 h-3.5" />Upload Screenshot
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </div>

                {screenshots.length === 0 ? (
                  <div className="py-16 flex flex-col items-center gap-3 text-center border-2 border-dashed rounded-xl">
                    <Image className="w-10 h-10 text-muted-foreground opacity-30" />
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">Belum ada screenshot</p>
                      <p className="text-xs text-muted-foreground mt-1">Upload screenshot percakapan untuk referensi AI</p>
                    </div>
                    <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 mt-1"
                      onClick={() => fileInputRef.current?.click()}>
                      <Upload className="w-3.5 h-3.5" />Pilih Gambar
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {screenshots.map((s) => (
                      <div key={s.id} className="rounded-lg border overflow-hidden group">
                        <div className="relative aspect-video bg-muted">
                          <img src={s.url} alt={s.caption || "Screenshot"} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                            <button type="button"
                              className="p-1.5 rounded-full bg-white/90 hover:bg-white text-foreground"
                              onClick={() => setLightboxUrl(s.url)} title="Lihat penuh">
                              <ZoomIn className="w-4 h-4" />
                            </button>
                            <a href={s.url} download={s.file.name}
                              className="p-1.5 rounded-full bg-white/90 hover:bg-white text-foreground" title="Unduh">
                              <Download className="w-4 h-4" />
                            </a>
                            <button type="button"
                              className="p-1.5 rounded-full bg-white/90 hover:bg-white text-destructive"
                              onClick={() => removeScreenshot(s.id)} title="Hapus">
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        <div className="p-2">
                          {editingId === s.id ? (
                            <div className="flex gap-1.5">
                              <Input
                                value={captionEdit}
                                onChange={(e) => setCaptionEdit(e.target.value)}
                                placeholder="Keterangan..."
                                className="h-7 text-xs flex-1"
                                autoFocus
                                onKeyDown={(e) => { if (e.key === "Enter") saveCaption(s.id); if (e.key === "Escape") setEditingId(null); }}
                              />
                              <Button size="sm" className="h-7 px-2 text-xs" onClick={() => saveCaption(s.id)}>OK</Button>
                            </div>
                          ) : (
                            <button type="button"
                              className="text-xs text-muted-foreground text-left w-full hover:text-foreground line-clamp-2"
                              onClick={() => { setEditingId(s.id); setCaptionEdit(s.caption); }}>
                              {s.caption || <span className="italic">Tambah keterangan…</span>}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
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
                    <p className="text-lg font-bold text-foreground">{sentFU.length}</p>
                    <p className="text-[10px] text-muted-foreground">Terkirim</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    <p className="text-xs font-medium text-foreground truncate">
                      {lastSent?.sentAt ? formatDateShort(lastSent.sentAt) : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Terakhir</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
                    {firstPending?.scheduledAt ? (
                      <>
                        <p className={cn(
                          "text-xs font-medium truncate",
                          new Date(firstPending.scheduledAt) < new Date() ? "text-rose-600" : "text-foreground"
                        )}>
                          {formatDateShort(firstPending.scheduledAt)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Berikutnya</p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">—</p>
                        <p className="text-[10px] text-muted-foreground">Berikutnya</p>
                      </>
                    )}
                  </div>
                </div>

                {/* Template editor */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Pesan Follow Up</Label>
                    {aiTemplate && template !== aiTemplate ? (
                      <button type="button"
                        className="text-[10px] text-primary hover:underline"
                        onClick={() => setTemplate(aiTemplate)}>
                        Reset ke template AI
                      </button>
                    ) : null}
                  </div>
                  <Textarea
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    placeholder="Tulis pesan follow up, atau gunakan template AI di atas…"
                    className="text-xs min-h-[100px]"
                  />
                  {aiTemplate && !template ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 w-full"
                      onClick={() => setTemplate(aiTemplate)}>
                      <Brain className="w-3 h-3" />Gunakan Template AI
                    </Button>
                  ) : null}
                </div>

                {/* Send actions */}
                <div className="flex gap-2">
                  <a
                    href={waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "flex-1 inline-flex items-center justify-center gap-2 rounded-md border text-sm font-medium h-9 px-4 transition-colors",
                      "bg-green-600 hover:bg-green-700 text-white border-transparent"
                    )}
                  >
                    <Smartphone className="w-4 h-4" />
                    Kirim via WhatsApp
                  </a>
                </div>

                {/* Follow-up history */}
                {fuLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (followUps ?? []).length === 0 ? (
                  <div className="py-8 text-center">
                    <Send className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-40" />
                    <p className="text-sm text-muted-foreground">Belum ada rencana follow-up.</p>
                    <p className="text-xs text-muted-foreground mt-1">Follow-up otomatis akan muncul di sini.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Riwayat Follow Up</p>
                    {(followUps ?? []).map((fu) => {
                      const statusInfo = FOLLOWUP_STATUS_LABEL[fu.status] ?? { label: fu.status, color: "text-muted-foreground bg-muted" };
                      const isPending = fu.status === "pending";
                      const isSent = fu.status === "sent";
                      return (
                        <div key={fu.id} className="rounded-lg border bg-card p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              {isSent ? (
                                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                              ) : fu.status === "cancelled" || fu.status === "skipped" ? (
                                <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                              ) : (
                                <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/40 shrink-0 flex items-center justify-center">
                                  <span className="text-[8px] font-bold text-muted-foreground">{fu.sequence}</span>
                                </div>
                              )}
                              <span className="text-sm font-medium">Touch #{fu.sequence}</span>
                            </div>
                            <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium", statusInfo.color)}>
                              {statusInfo.label}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {isSent && fu.sentAt
                              ? `Terkirim ${formatDate(fu.sentAt)}`
                              : `Dijadwalkan ${formatDate(fu.scheduledAt)}`}
                          </div>
                          {fu.generatedMessage ? (
                            <div className="rounded-md bg-muted/50 p-2.5">
                              <p className="text-xs leading-relaxed">{fu.generatedMessage}</p>
                            </div>
                          ) : null}
                          {isPending ? (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" className="flex-1 h-8 text-xs gap-1.5"
                                onClick={() => { setTemplate(fu.generatedMessage ?? ""); }}>
                                <Brain className="w-3 h-3" />Gunakan Pesan Ini
                              </Button>
                              <Button size="sm" variant="outline" className="flex-1 h-8 text-xs gap-1.5"
                                onClick={() => sendFollowUp({ id: opp.id, followUpId: fu.id })}
                                disabled={sending}>
                                {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                Kirim via API
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground gap-1"
                                onClick={() => cancelFollowUp({ id: opp.id, followUpId: fu.id, data: { status: "cancelled" } })}
                                disabled={cancelling}>
                                <X className="w-3 h-3" />Batal
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t shrink-0">
            {tab === "detail" && canEdit ? (
              <>
                <Button variant="outline" size="sm" onClick={onClose}>Batal</Button>
                <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
                  {update.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Simpan
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={onClose}>Tutup</Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Lightbox ── */}
      {lightboxUrl ? (
        <div
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
            onClick={() => setLightboxUrl(null)}
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightboxUrl}
            alt="Screenshot"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}
