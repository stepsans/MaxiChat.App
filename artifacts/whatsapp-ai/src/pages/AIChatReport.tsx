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
  type AcrJob,
} from "@workspace/api-client-react";
import {
  Archive,
  Bell,
  ClipboardCheck,
  Download,
  Eye,
  FileText,
  Loader2,
  Plus,
  Settings as SettingsIcon,
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
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

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
  customer_angry: "Customer Marah",
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

  useEffect(() => {
    if (open) {
      const d = defaultPeriod();
      setStart(d.start);
      setEnd(d.end);
      setMode("all");
      setSelected(new Set());
    }
  }, [open]);

  const { data: config } = useGetAcrConfig({
    query: { queryKey: getGetAcrConfigQueryKey(), enabled: open },
  });
  const { data: members } = useListAcrTeamMembers({
    query: { queryKey: getListAcrTeamMembersQueryKey(), enabled: open },
  });
  const createJob = useCreateAcrJob();

  const spanDays =
    (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
    86_400_000;
  const invalid =
    !start || !end || end < start || spanDays > 90 || (mode === "select" && selected.size === 0);

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
          <DialogTitle>Buat Laporan Baru</DialogTitle>
          <DialogDescription>
            Default 30 hari terakhir (month-to-date mundur). Maksimal 90 hari.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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

          {config && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              <p className="mb-1 font-medium">Preview Konfigurasi Bobot</p>
              <p>
                Kecepatan Balas {config.weightResponseTime} · Kualitas Bahasa{" "}
                {config.weightLanguageQuality} · Ketepatan {config.weightAnswerQuality} ·
                Komplain {config.weightComplaintHandling} · Missed {config.weightMissedChat}
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button onClick={submit} disabled={invalid || createJob.isPending} data-testid="acr-run">
            {createJob.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Jalankan Penilaian
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                <TableHead>Dibuat Oleh</TableHead>
                <TableHead className="text-right">Agent Dinilai</TableHead>
                <TableHead className="text-right">Percakapan</TableHead>
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
                    {job.isAutoScheduled ? "Otomatis" : job.requestedByName ?? "-"}
                  </TableCell>
                  <TableCell className="text-right">{job.totalAgentsEvaluated}</TableCell>
                  <TableCell className="text-right">
                    {job.totalConversationsAnalyzed}
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

      <CreateReportDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
