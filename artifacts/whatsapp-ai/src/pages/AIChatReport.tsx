import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAcrJobs,
  getListAcrJobsQueryKey,
  useCreateAcrJob,
  useArchiveAcrJob,
  useGetAcrConfig,
  getGetAcrConfigQueryKey,
  useListAcrTeamMembers,
  getListAcrTeamMembersQueryKey,
  useListAcrNotifications,
  getListAcrNotificationsQueryKey,
  useMarkAllAcrNotificationsRead,
  useListChannels,
  getListChannelsQueryKey,
  useListCustomerLabels,
  getListCustomerLabelsQueryKey,
  useListAcrSchedules,
  getListAcrSchedulesQueryKey,
  useCreateAcrSchedule,
  useUpdateAcrSchedule,
  useDeleteAcrSchedule,
  useSetAcrScheduleActive,
  useRunAcrSchedule,
  type AcrJob,
  type AcrSchedule,
  type AcrFilterSnapshot,
} from "@workspace/api-client-react";
import {
  Archive,
  Bell,
  CalendarClock,
  ClipboardCheck,
  LayoutDashboard,
  Download,
  Eye,
  FileText,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";
import AcrDashboardTab from "./AcrDashboardTab";

// ─── helpers ────────────────────────────────────────────────────────────────

const fmtDate = (d: string): string =>
  new Date(`${d}T00:00:00+07:00`).toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const fmtDateTime = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

const isoDate = (d: Date): string => {
  // Date input value in WIB.
  const wib = new Date(d.getTime() + 7 * 3600_000);
  return wib.toISOString().slice(0, 10);
};

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86_400_000);
  return { start: isoDate(start), end: isoDate(now) };
}

export const VIOLATION_LABELS: Record<string, string> = {
  customer_angry: "Customer Tidak Puas",
  rude_language: "Bahasa Tidak Sopan",
  no_reply_critical: "Tidak Dibalas",
  customer_ignored: "Customer Dicuekin",
  answer_caused_dropout: "Jawaban Menyebabkan Dropout",
};

// Shared binary download (CSV/PDF endpoints are deliberately not in OpenAPI).
export async function downloadAcrExport(
  jobId: string,
  kind: "csv" | "pdf",
  filename: string
): Promise<void> {
  const res = await fetch(`/api/acr/jobs/${jobId}/export/${kind}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Gagal mengunduh ${kind.toUpperCase()}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Notification bell ──────────────────────────────────────────────────────

export function AcrNotificationBell() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: notifications } = useListAcrNotifications(
    {},
    {
      query: {
        queryKey: getListAcrNotificationsQueryKey({}),
        refetchInterval: 30_000,
      },
    }
  );
  const markAll = useMarkAllAcrNotificationsRead();
  const unread = (notifications ?? []).filter((n) => !n.isRead);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative" data-testid="acr-bell">
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white">
              {unread.length > 99 ? "99+" : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifikasi Red Flag</span>
          {unread.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                markAll.mutate(undefined, {
                  onSuccess: () =>
                    qc.invalidateQueries({
                      queryKey: getListAcrNotificationsQueryKey({}),
                    }),
                })
              }
            >
              Tandai semua dibaca
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {(notifications ?? []).length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">Belum ada notifikasi.</p>
          )}
          {(notifications ?? []).map((n) => (
            <button
              key={n.id}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-muted/50",
                !n.isRead && "bg-red-50 dark:bg-red-950/20"
              )}
              onClick={() => {
                if (n.jobId) {
                  navigate(
                    `/ai-chat-report/${n.jobId}?tab=redflags${
                      n.redFlagId ? `&flag=${n.redFlagId}` : ""
                    }&notif=${n.id}`
                  );
                }
              }}
            >
              <span className="font-medium">
                🔴 {n.agentName ?? "Agent"} —{" "}
                {n.violationType
                  ? VIOLATION_LABELS[n.violationType] ?? n.violationType
                  : "Laporan otomatis selesai"}
              </span>
              <span className="text-xs text-muted-foreground">
                {n.contactName ? `Percakapan dengan ${n.contactName} · ` : ""}
                {fmtDateTime(n.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Status badge ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AcrJob["status"] }) {
  if (status === "completed")
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Selesai</Badge>;
  if (status === "failed") return <Badge variant="destructive">Gagal</Badge>;
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> Memproses
    </Badge>
  );
}

// ─── Filter Aktif badges (history "Filter Aktif" column) ────────────────────

const LEAD_LABELS: Record<string, string> = {
  lead: "Lead",
  not_lead: "Bukan Lead",
  unknown: "Belum Ditandai",
};
const CHAT_STATUS_LABELS: Record<string, string> = {
  ai_handled: "AI",
  needs_human: "Manusia",
  closed: "Selesai",
};

// Compact summary of the analysis filters a job ran with. Renders one chip per
// active filter group; falls back to "Semua" when nothing was narrowed, and
// "—" for pre-feature jobs that never recorded a snapshot.
function FilterAktifBadges({ snapshot }: { snapshot: AcrFilterSnapshot | null }) {
  if (!snapshot) return <span className="text-xs text-muted-foreground">—</span>;

  const chips: string[] = [];
  const cap = (items: string[], prefix: string) => {
    if (items.length === 0) return;
    const shown = items.slice(0, 2).join(", ");
    chips.push(`${prefix}: ${shown}${items.length > 2 ? ` +${items.length - 2}` : ""}`);
  };

  cap(
    snapshot.leadStatuses.map((s) => LEAD_LABELS[s] ?? s),
    "Lead"
  );
  cap(
    snapshot.channels.map((c) => c.label),
    "Channel"
  );
  cap(
    snapshot.customerLabels.map((l) => l.name),
    "Label"
  );
  cap(
    snapshot.chatStatuses.map((s) => CHAT_STATUS_LABELS[s] ?? s),
    "Status"
  );
  if (snapshot.includeOwner) chips.push("Owner");

  if (chips.length === 0)
    return <span className="text-xs text-muted-foreground">Semua</span>;

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c} variant="outline" className="text-[10px] font-normal">
          {c}
        </Badge>
      ))}
    </div>
  );
}

// ─── Create report modal ────────────────────────────────────────────────────

function CreateReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const def = defaultPeriod();
  const [start, setStart] = useState(def.start);
  const [end, setEnd] = useState(def.end);
  const [mode, setMode] = useState<"all" | "select">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // v2.6: lead status + chat status are Global Defaults (Pengaturan), no longer
  // set per manual report — they're inherited from config on the server.
  const [channelIds, setChannelIds] = useState<Set<number>>(new Set());
  const [labelIds, setLabelIds] = useState<Set<number>>(new Set());
  const [includeOwner, setIncludeOwner] = useState(false);
  // Notification recipients + post-report actions (default from config).
  const [notifyIds, setNotifyIds] = useState<Set<number>>(new Set());
  const [generatePdf, setGeneratePdf] = useState(true);
  const [sendWhatsappPdf, setSendWhatsappPdf] = useState(false);
  // Manual vs Otomatis (schedule) tab.
  const [modalTab, setModalTab] = useState("manual");
  const [sched, setSched] = useState<SchedValue>(emptySched());
  const createSchedule = useCreateAcrSchedule();

  const { data: config } = useGetAcrConfig({
    query: { queryKey: getGetAcrConfigQueryKey(), enabled: open },
  });
  const { data: members } = useListAcrTeamMembers({
    query: { queryKey: getListAcrTeamMembersQueryKey(), enabled: open },
  });
  const { data: channels } = useListChannels({
    query: { queryKey: getListChannelsQueryKey(), enabled: open },
  });
  const { data: labels } = useListCustomerLabels({
    query: { queryKey: getListCustomerLabelsQueryKey(), enabled: open },
  });
  const createJob = useCreateAcrJob();

  useEffect(() => {
    if (open) {
      const d = defaultPeriod();
      setStart(d.start);
      setEnd(d.end);
      setMode("all");
      setSelected(new Set());
      setChannelIds(new Set());
      setLabelIds(new Set());
      setIncludeOwner(config?.includeOwnerInEvaluation ?? false);
      setNotifyIds(new Set(config?.defaultNotifyUserIds ?? []));
      setGeneratePdf(config?.defaultGeneratePdf ?? true);
      setSendWhatsappPdf(config?.defaultSendWhatsappPdf ?? false);
      setModalTab("manual");
      setSched(emptySched());
    }
  }, [
    open,
    config?.includeOwnerInEvaluation,
    config?.defaultGeneratePdf,
    config?.defaultSendWhatsappPdf,
    config?.defaultNotifyUserIds,
  ]);

  const schedInvalid =
    !sched.name.trim() || (sched.agentMode === "select" && sched.agentIds.length === 0);

  const submitSchedule = () => {
    createSchedule.mutate(
      { data: schedToPayload(sched) },
      {
        onSuccess: () => {
          toast({ title: "Jadwal otomatis dibuat." });
          qc.invalidateQueries({ queryKey: getListAcrSchedulesQueryKey() });
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          const e = err as { data?: { error?: string }; message?: string };
          toast({
            title: "Gagal membuat jadwal",
            description: e?.data?.error ?? e?.message ?? "Terjadi kesalahan.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const spanDays =
    (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
    86_400_000;
  const invalid =
    !start ||
    !end ||
    end < start ||
    spanDays > 90 ||
    (mode === "select" && selected.size === 0);

  const preset = (days: number | "month") => {
    const now = new Date();
    if (days === "month") {
      const wibNow = new Date(now.getTime() + 7 * 3600_000);
      const first = `${wibNow.toISOString().slice(0, 8)}01`;
      setStart(first);
      setEnd(isoDate(now));
      return;
    }
    setStart(isoDate(new Date(now.getTime() - days * 86_400_000)));
    setEnd(isoDate(now));
  };

  const submit = () => {
    createJob.mutate(
      {
        data: {
          periodStart: start,
          periodEnd: end,
          agentIds: mode === "select" ? [...selected] : undefined,
          channelIds: channelIds.size > 0 ? [...channelIds] : undefined,
          customerLabelIds: labelIds.size > 0 ? [...labelIds] : undefined,
          includeOwner,
          notifyUserIds: [...notifyIds],
          generatePdf,
          sendWhatsappPdf,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Penilaian sedang diproses..." });
          qc.invalidateQueries({ queryKey: getListAcrJobsQueryKey() });
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          const e = err as { data?: { error?: string }; message?: string };
          toast({
            title: "Gagal membuat laporan",
            description: e?.data?.error ?? e?.message ?? "Terjadi kesalahan.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Buat Laporan</DialogTitle>
          <DialogDescription>
            Manual: sekali jalan. Otomatis: jadwal berulang harian/mingguan/bulanan.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={modalTab} onValueChange={setModalTab}>
          <TabsList className="mb-3">
            <TabsTrigger value="manual">Manual</TabsTrigger>
            <TabsTrigger value="otomatis">Otomatis</TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="space-y-4">
          <div>
            <Label className="mb-1 block">Periode Penilaian</Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={start}
                max={end}
                onChange={(e) => setStart(e.target.value)}
                data-testid="acr-period-start"
              />
              <span className="text-muted-foreground">→</span>
              <Input
                type="date"
                value={end}
                min={start}
                onChange={(e) => setEnd(e.target.value)}
                data-testid="acr-period-end"
              />
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => preset(0)}>
                Hari ini
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(7)}>
                7 hari
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(30)}>
                30 hari
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset("month")}>
                Bulan ini
              </Button>
            </div>
            {spanDays > 90 && (
              <p className="mt-1 text-xs text-red-500">Periode maksimal 90 hari.</p>
            )}
          </div>

          <div>
            <Label className="mb-1 block">Nilai Agent</Label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === "all"}
                  onChange={() => setMode("all")}
                />
                Semua Agent
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === "select"}
                  onChange={() => setMode("select")}
                />
                Pilih agent tertentu
              </label>
              {mode === "select" && (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                  {(members ?? []).map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.has(m.id)}
                        onCheckedChange={(v) => {
                          const next = new Set(selected);
                          if (v) next.add(m.id);
                          else next.delete(m.id);
                          setSelected(next);
                        }}
                      />
                      {m.name ?? m.email}
                      <span className="text-xs text-muted-foreground">({m.teamRole})</span>
                    </label>
                  ))}
                  {(members ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Belum ada supervisor/agent di tim.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Channel</Label>
            <p className="mb-1 text-xs text-muted-foreground">
              Kosongkan untuk menilai semua channel.
            </p>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
              {(channels ?? []).map((ch) => (
                <label key={ch.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={channelIds.has(ch.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(channelIds);
                      if (v) next.add(ch.id);
                      else next.delete(ch.id);
                      setChannelIds(next);
                    }}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: ch.color }}
                  />
                  {ch.label}
                </label>
              ))}
              {(channels ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">Belum ada channel.</p>
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Label Customer</Label>
            <p className="mb-1 text-xs text-muted-foreground">
              Kosongkan untuk menilai semua chat tanpa filter label.
            </p>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
              {(labels ?? []).map((lb) => (
                <label key={lb.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={labelIds.has(lb.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(labelIds);
                      if (v) next.add(lb.id);
                      else next.delete(lb.id);
                      setLabelIds(next);
                    }}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: lb.color }}
                  />
                  {lb.name}
                </label>
              ))}
              {(labels ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">Belum ada label customer.</p>
              )}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeOwner}
                onCheckedChange={(v) => setIncludeOwner(v === true)}
              />
              Sertakan super admin (owner) sebagai agent yang dinilai
            </label>
          </div>

          <div>
            <Label className="mb-1 block">Kirim Notifikasi Ke</Label>
            <label className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked disabled />
              Super Admin / Owner Tenant (selalu menerima)
            </label>
            <p className="mb-1 text-xs text-muted-foreground">
              Default penerima diatur di Pengaturan. Tambah penerima khusus laporan ini.
            </p>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
              {(members ?? []).map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={notifyIds.has(m.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(notifyIds);
                      if (v) next.add(m.id);
                      else next.delete(m.id);
                      setNotifyIds(next);
                    }}
                  />
                  {m.name ?? m.email}
                  <span className="text-xs text-muted-foreground">({m.teamRole})</span>
                </label>
              ))}
              {(members ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">Belum ada anggota tim.</p>
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Aksi Setelah Laporan Selesai</Label>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked disabled />
                Simpan ke Dashboard KPI (selalu aktif)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={generatePdf}
                  onCheckedChange={(v) => setGeneratePdf(v === true)}
                />
                Generate PDF otomatis
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={sendWhatsappPdf}
                  onCheckedChange={(v) => setSendWhatsappPdf(v === true)}
                />
                Kirim PDF via WhatsApp ke penerima
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button
              onClick={submit}
              disabled={invalid || createJob.isPending}
              data-testid="acr-run"
            >
              {createJob.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Jalankan Penilaian
            </Button>
          </DialogFooter>
          </TabsContent>

          <TabsContent value="otomatis" className="space-y-4">
            <ScheduleFields
              value={sched}
              onChange={(p) => setSched((v) => ({ ...v, ...p }))}
              members={members ?? []}
              channels={channels ?? []}
              labels={labels ?? []}
              config={config}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Batal
              </Button>
              <Button onClick={submitSchedule} disabled={schedInvalid || createSchedule.isPending}>
                {createSchedule.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Simpan Jadwal
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Schedules (Bagian II) ────────────────────────────────────────────────

const WEEKDAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

interface SchedValue {
  name: string;
  frequency: "daily" | "weekly" | "monthly";
  dayOfWeek: number;
  dayOfMonth: number;
  cutoffHour: number;
  cutoffMinute: number;
  agentMode: "all" | "select";
  agentIds: number[];
  // v2.6: lead status, recipients, and post-report actions are Global Defaults
  // (Pengaturan), read live at run time — not part of a schedule.
  channelIds: number[];
  labelIds: number[];
  chatStatuses: ("ai_handled" | "needs_human" | "closed")[];
  includeOwner: boolean;
  isActive: boolean;
}

const emptySched = (): SchedValue => ({
  name: "",
  frequency: "weekly",
  dayOfWeek: 1,
  dayOfMonth: 1,
  cutoffHour: 9,
  cutoffMinute: 0,
  agentMode: "all",
  agentIds: [],
  channelIds: [],
  labelIds: [],
  chatStatuses: [],
  includeOwner: false,
  isActive: true,
});

const schedFromApi = (s: AcrSchedule): SchedValue => ({
  name: s.name,
  frequency: s.frequency,
  dayOfWeek: s.dayOfWeek ?? 1,
  dayOfMonth: s.dayOfMonth ?? 1,
  cutoffHour: s.cutoffHour,
  cutoffMinute: s.cutoffMinute,
  agentMode: s.agentIds && s.agentIds.length > 0 ? "select" : "all",
  agentIds: s.agentIds ?? [],
  channelIds: s.channelIds ?? [],
  labelIds: s.customerLabelIds ?? [],
  chatStatuses: s.chatStatuses ?? [],
  includeOwner: s.includeOwner ?? false,
  isActive: s.isActive,
});

const schedToPayload = (v: SchedValue) => ({
  name: v.name.trim(),
  frequency: v.frequency,
  ...(v.frequency === "weekly" ? { dayOfWeek: v.dayOfWeek } : {}),
  ...(v.frequency === "monthly" ? { dayOfMonth: v.dayOfMonth } : {}),
  cutoffHour: v.cutoffHour,
  cutoffMinute: v.cutoffMinute,
  agentIds: v.agentMode === "select" ? v.agentIds : undefined,
  channelIds: v.channelIds.length > 0 ? v.channelIds : undefined,
  customerLabelIds: v.labelIds.length > 0 ? v.labelIds : undefined,
  chatStatuses: v.chatStatuses.length > 0 ? v.chatStatuses : undefined,
  includeOwner: v.includeOwner,
  isActive: v.isActive,
});

const schedSummary = (s: AcrSchedule): string => {
  const time = `${String(s.cutoffHour).padStart(2, "0")}.${String(s.cutoffMinute).padStart(2, "0")} WIB`;
  if (s.frequency === "daily") return `Harian · ${time}`;
  if (s.frequency === "weekly") return `Mingguan · ${WEEKDAYS[s.dayOfWeek ?? 1]} ${time}`;
  return `Bulanan · tgl ${s.dayOfMonth ?? 1} ${time}`;
};

function ScheduleFields({
  value,
  onChange,
  members,
  channels,
  labels,
  config,
}: {
  value: SchedValue;
  onChange: (patch: Partial<SchedValue>) => void;
  members: { id: number; name?: string | null; email: string; teamRole: string }[];
  channels: { id: number; label: string; color: string }[];
  labels: { id: number; name: string; color: string }[];
  config?: {
    weightResponseTime: number;
    weightLanguageQuality: number;
    weightAnswerQuality: number;
    weightComplaintHandling: number;
    weightMissedChat: number;
  };
}) {
  const invalidName = !value.name.trim();
  const [subTab, setSubTab] = useState("jadwal");
  const toggle = <T,>(list: T[], item: T, on: boolean): T[] =>
    on ? [...list, item] : list.filter((x) => x !== item);
  // Active filter count badge for the "Filter & Bobot" tab.
  const filterCount =
    value.channelIds.length +
    value.labelIds.length +
    value.chatStatuses.length +
    (value.includeOwner ? 1 : 0);
  return (
    <Tabs value={subTab} onValueChange={setSubTab} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="jadwal" className={invalidName ? "text-red-500" : ""}>
          Jadwal & Agent
        </TabsTrigger>
        <TabsTrigger value="filter">
          Filter & Bobot{filterCount > 0 ? ` (${filterCount})` : ""}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="jadwal" className="mt-3 space-y-4">
      <div>
        <Label className="mb-1 block">Nama Jadwal</Label>
        <Input
          placeholder="Contoh: Laporan Mingguan Tim CS"
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {invalidName && <p className="mt-1 text-xs text-red-500">Nama wajib diisi.</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="mb-1 block">Frekuensi</Label>
          <Select
            value={value.frequency}
            onValueChange={(v) => onChange({ frequency: v as SchedValue["frequency"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Harian</SelectItem>
              <SelectItem value="weekly">Mingguan</SelectItem>
              <SelectItem value="monthly">Bulanan</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {value.frequency === "weekly" && (
          <div>
            <Label className="mb-1 block">Hari</Label>
            <Select
              value={String(value.dayOfWeek)}
              onValueChange={(v) => onChange({ dayOfWeek: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {value.frequency === "monthly" && (
          <div>
            <Label className="mb-1 block">Tanggal (1–28)</Label>
            <Input
              type="number"
              min={1}
              max={28}
              value={value.dayOfMonth}
              onChange={(e) =>
                onChange({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })
              }
            />
          </div>
        )}
      </div>

      <div>
        <Label className="mb-1 block">Jam Eksekusi (WIB)</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={23}
            className="w-20"
            value={value.cutoffHour}
            onChange={(e) =>
              onChange({ cutoffHour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
          <span>:</span>
          <Input
            type="number"
            min={0}
            max={59}
            className="w-20"
            value={value.cutoffMinute}
            onChange={(e) =>
              onChange({ cutoffMinute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
        </div>
      </div>

      <div>
        <Label className="mb-1 block">Nilai Agent</Label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={value.agentMode === "all"}
              onChange={() => onChange({ agentMode: "all" })}
            />
            Semua Agent
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={value.agentMode === "select"}
              onChange={() => onChange({ agentMode: "select" })}
            />
            Pilih agent tertentu
          </label>
          {value.agentMode === "select" && (
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
              {members.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={value.agentIds.includes(m.id)}
                    onCheckedChange={(c) =>
                      onChange({
                        agentIds: c
                          ? [...value.agentIds, m.id]
                          : value.agentIds.filter((x) => x !== m.id),
                      })
                    }
                  />
                  {m.name ?? m.email}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      </TabsContent>

      <TabsContent value="filter" className="mt-3 space-y-4">
      <p className="text-xs text-muted-foreground">
        Status Lead, penerima notifikasi, dan aksi (PDF/WhatsApp) mengikuti Default Filter
        Global di Pengaturan saat jadwal dijalankan.
      </p>

      <div>
        <Label className="mb-1 block">Channel</Label>
        <p className="mb-1 text-xs text-muted-foreground">
          Kosongkan untuk menilai semua channel.
        </p>
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
          {channels.map((ch) => (
            <label key={ch.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.channelIds.includes(ch.id)}
                onCheckedChange={(c) =>
                  onChange({ channelIds: toggle(value.channelIds, ch.id, c === true) })
                }
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: ch.color }}
              />
              {ch.label}
            </label>
          ))}
          {channels.length === 0 && (
            <p className="text-xs text-muted-foreground">Belum ada channel.</p>
          )}
        </div>
      </div>

      <div>
        <Label className="mb-1 block">Label Customer</Label>
        <p className="mb-1 text-xs text-muted-foreground">
          Kosongkan untuk menilai semua chat tanpa filter label.
        </p>
        <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
          {labels.map((lb) => (
            <label key={lb.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.labelIds.includes(lb.id)}
                onCheckedChange={(c) =>
                  onChange({ labelIds: toggle(value.labelIds, lb.id, c === true) })
                }
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: lb.color }}
              />
              {lb.name}
            </label>
          ))}
          {labels.length === 0 && (
            <p className="text-xs text-muted-foreground">Belum ada label customer.</p>
          )}
        </div>
      </div>

      <div>
        <Label className="mb-1 block">Status Penanganan Chat</Label>
        <p className="mb-1 text-xs text-muted-foreground">
          Kosongkan untuk menilai semua status.
        </p>
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["ai_handled", "Ditangani AI"],
              ["needs_human", "Perlu Manusia"],
              ["closed", "Selesai"],
            ] as const
          ).map(([v, text]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.chatStatuses.includes(v)}
                onCheckedChange={(c) =>
                  onChange({ chatStatuses: toggle(value.chatStatuses, v, c === true) })
                }
              />
              {text}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.includeOwner}
            onCheckedChange={(c) => onChange({ includeOwner: c === true })}
          />
          Sertakan super admin (owner) sebagai agent yang dinilai
        </label>
      </div>

      {config && (
        <div className="rounded-md border bg-muted/40 p-3 text-xs">
          <p className="mb-1 font-medium">Preview Konfigurasi Bobot</p>
          <p>
            Kecepatan Balas {config.weightResponseTime} · Kualitas Bahasa{" "}
            {config.weightLanguageQuality} · Ketepatan {config.weightAnswerQuality} · Komplain{" "}
            {config.weightComplaintHandling} · Missed {config.weightMissedChat}
          </p>
          <a
            href="/ai-chat-report/settings"
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-primary underline"
          >
            Ubah Konfigurasi →
          </a>
        </div>
      )}
      </TabsContent>
    </Tabs>
  );
}

function ScheduleDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: AcrSchedule | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState<SchedValue>(emptySched());
  const { data: members } = useListAcrTeamMembers({
    query: { queryKey: getListAcrTeamMembersQueryKey(), enabled: open },
  });
  const { data: config } = useGetAcrConfig({
    query: { queryKey: getGetAcrConfigQueryKey(), enabled: open },
  });
  const { data: channels } = useListChannels({
    query: { queryKey: getListChannelsQueryKey(), enabled: open },
  });
  const { data: labels } = useListCustomerLabels({
    query: { queryKey: getListCustomerLabelsQueryKey(), enabled: open },
  });
  const create = useCreateAcrSchedule();
  const update = useUpdateAcrSchedule();
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (open) setValue(editing ? schedFromApi(editing) : emptySched());
  }, [open, editing]);

  const invalid =
    !value.name.trim() || (value.agentMode === "select" && value.agentIds.length === 0);

  const submit = () => {
    const data = schedToPayload(value);
    const onSuccess = () => {
      toast({ title: editing ? "Jadwal diperbarui." : "Jadwal dibuat." });
      qc.invalidateQueries({ queryKey: getListAcrSchedulesQueryKey() });
      onOpenChange(false);
    };
    const onError = (err: unknown) => {
      const e = err as { data?: { error?: string }; message?: string };
      toast({
        title: "Gagal menyimpan jadwal",
        description: e?.data?.error ?? e?.message ?? "Terjadi kesalahan.",
        variant: "destructive",
      });
    };
    if (editing) {
      update.mutate({ id: editing.id, data }, { onSuccess, onError });
    } else {
      create.mutate({ data }, { onSuccess, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Jadwal" : "Tambah Jadwal Otomatis"}</DialogTitle>
          <DialogDescription>
            Laporan dibuat otomatis sesuai frekuensi. Data yang dianalisa: 1/7/30 hari sebelum
            eksekusi (harian/mingguan/bulanan).
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <ScheduleFields
            value={value}
            onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
            members={members ?? []}
            channels={channels ?? []}
            labels={labels ?? []}
            config={config}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button onClick={submit} disabled={invalid || pending}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Simpan" : "Buat Jadwal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchedulesTab({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AcrSchedule | null>(null);
  const { data: schedules, isLoading } = useListAcrSchedules({
    query: { queryKey: getListAcrSchedulesQueryKey() },
  });
  const setActive = useSetAcrScheduleActive();
  const del = useDeleteAcrSchedule();
  const run = useRunAcrSchedule();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListAcrSchedulesQueryKey() });

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Tambah Jadwal
          </Button>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (schedules ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          Belum ada jadwal otomatis.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nama</TableHead>
                <TableHead>Jadwal</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Berikutnya</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(schedules ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{schedSummary(s)}</TableCell>
                  <TableCell>
                    {s.isActive ? (
                      <Badge className="bg-green-600 text-white hover:bg-green-600">Aktif</Badge>
                    ) : (
                      <Badge variant="outline">Jeda</Badge>
                    )}
                  </TableCell>
                  <TableCell>{fmtDateTime(s.nextRunAt)}</TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Jalankan Sekarang"
                          onClick={() =>
                            run.mutate(
                              { id: s.id },
                              {
                                onSuccess: () => toast({ title: "Laporan sedang diproses…" }),
                                onError: () =>
                                  toast({ title: "Gagal menjalankan", variant: "destructive" }),
                              }
                            )
                          }
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={s.isActive ? "Jeda" : "Aktifkan"}
                          onClick={() =>
                            setActive.mutate(
                              { id: s.id, data: { isActive: !s.isActive } },
                              { onSuccess: invalidate }
                            )
                          }
                        >
                          {s.isActive ? (
                            <Pause className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit"
                          onClick={() => {
                            setEditing(s);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Hapus"
                          onClick={() => {
                            if (!window.confirm(`Hapus jadwal "${s.name}"?`)) return;
                            del.mutate(
                              { id: s.id },
                              {
                                onSuccess: () => {
                                  toast({ title: "Jadwal dihapus." });
                                  invalidate();
                                },
                              }
                            );
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ScheduleDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AIChatReport() {
  const [, navigate] = useLocation();
  const { menus, isSuperAdmin, isLoading: permsLoading } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState("riwayat");

  // Self-guard: routes are unguarded, every page checks its own canView.
  useEffect(() => {
    if (!permsLoading && !menus.acr.canView) navigate("/");
  }, [permsLoading, menus.acr.canView, navigate]);

  const params = { page, limit: 10, archived: false };
  const { data, isLoading } = useListAcrJobs(params, {
    query: { queryKey: getListAcrJobsQueryKey(params) },
  });
  const anyRunning = useMemo(
    () => (data?.jobs ?? []).some((j) => j.status === "running" || j.status === "pending"),
    [data]
  );
  // Poll while a job is processing (spec: every 3s).
  useListAcrJobs(params, {
    query: {
      queryKey: getListAcrJobsQueryKey(params),
      refetchInterval: anyRunning ? 3000 : false,
    },
  });

  const archiveJob = useArchiveAcrJob();

  const onDownload = async (job: AcrJob, kind: "csv" | "pdf") => {
    try {
      await downloadAcrExport(
        job.id,
        kind,
        `acr-${job.periodStart}_${job.periodEnd}.${kind}`
      );
    } catch (err) {
      toast({
        title: "Unduhan gagal",
        description: err instanceof Error ? err.message : "Terjadi kesalahan.",
        variant: "destructive",
      });
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">AI Chat Report</h1>
        </div>
        <div className="flex items-center gap-2">
          <AcrNotificationBell />
          {isSuperAdmin && (
            <Button
              variant="outline"
              onClick={() => navigate("/ai-chat-report/settings")}
              data-testid="acr-settings"
            >
              <SettingsIcon className="mr-2 h-4 w-4" /> Pengaturan
            </Button>
          )}
          {menus.acr.canCreate && (
            <Button onClick={() => setCreateOpen(true)} data-testid="acr-create">
              <Plus className="mr-2 h-4 w-4" /> Buat Laporan Baru
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="riwayat">Riwayat Laporan</TabsTrigger>
          {isSuperAdmin && (
            <TabsTrigger value="dashboard">
              <LayoutDashboard className="mr-1.5 h-4 w-4" /> Dashboard KPI
            </TabsTrigger>
          )}
          <TabsTrigger value="jadwal">
            <CalendarClock className="mr-1.5 h-4 w-4" /> Jadwal Otomatis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="riwayat" className="space-y-6">
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (data?.jobs ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          Belum ada laporan.{" "}
          {menus.acr.canCreate
            ? "Klik '+ Buat Laporan Baru' untuk mulai."
            : "Laporan akan tampil di sini setelah dibuat."}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Periode</TableHead>
                <TableHead>Tipe</TableHead>
                <TableHead>Dibuat Oleh</TableHead>
                <TableHead className="text-right">Agent Dinilai</TableHead>
                <TableHead className="text-right">Percakapan</TableHead>
                <TableHead>Filter Aktif</TableHead>
                <TableHead>Dijalankan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.jobs ?? []).map((job) => (
                <TableRow
                  key={job.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/ai-chat-report/${job.id}`)}
                  data-testid={`acr-job-${job.id}`}
                >
                  <TableCell className="font-medium">
                    {fmtDate(job.periodStart)} – {fmtDate(job.periodEnd)}
                    {job.isLatestForPeriod && job.status === "completed" && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        Terbaru
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {job.isAutoScheduled ? (
                      <Badge variant="secondary" className="text-[10px]">
                        🔄 Otomatis
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        Manual
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {job.isAutoScheduled ? "Otomatis" : job.requestedByName ?? "-"}
                  </TableCell>
                  <TableCell className="text-right">{job.totalAgentsEvaluated}</TableCell>
                  <TableCell className="text-right">
                    {job.totalConversationsAnalyzed}
                  </TableCell>
                  <TableCell>
                    <FilterAktifBadges snapshot={job.filterSnapshot ?? null} />
                  </TableCell>
                  <TableCell>{fmtDateTime(job.startedAt ?? job.createdAt)}</TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                    {(job.status === "running" || job.status === "pending") &&
                      (job.progressTotal ?? 0) > 0 && (
                        <div className="mt-1 w-32">
                          <Progress
                            value={
                              ((job.progressCompleted ?? 0) / (job.progressTotal ?? 1)) * 100
                            }
                          />
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {job.progressCompleted} / {job.progressTotal} percakapan
                          </p>
                        </div>
                      )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Lihat Detail"
                        onClick={() => navigate(`/ai-chat-report/${job.id}`)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Unduh CSV"
                        disabled={job.status !== "completed"}
                        onClick={() => void onDownload(job, "csv")}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Unduh PDF"
                        disabled={job.status !== "completed"}
                        onClick={() => void onDownload(job, "pdf")}
                      >
                        <FileText className="h-4 w-4" />
                      </Button>
                      {isSuperAdmin && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Arsipkan"
                          onClick={() =>
                            archiveJob.mutate(
                              { jobId: job.id },
                              {
                                onSuccess: () => {
                                  toast({ title: "Laporan diarsipkan." });
                                  qc.invalidateQueries({
                                    queryKey: getListAcrJobsQueryKey(),
                                  });
                                },
                              }
                            )
                          }
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Sebelumnya
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Berikutnya
          </Button>
        </div>
      )}
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="dashboard">
            <AcrDashboardTab />
          </TabsContent>
        )}

        <TabsContent value="jadwal">
          <SchedulesTab canManage={menus.acr.canCreate} />
        </TabsContent>
      </Tabs>

      <CreateReportDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
