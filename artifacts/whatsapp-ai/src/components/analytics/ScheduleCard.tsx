import { useState } from "react";
import {
  useToggleReportSchedule,
  useSendReportScheduleNow,
  useDeleteReportSchedule,
  getListReportSchedulesQueryKey,
  type ReportSchedule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Pencil, Play, Pause, Trash2, ChevronDown, Send } from "lucide-react";
import { ScheduleHistoryLog } from "./ScheduleHistoryLog";
import { CONTENT_TYPE_LABEL, frequencyLabel, formatRecurrenceDays, formatDateTime } from "./format";

function statusBadge(s: ReportSchedule): { label: string; cls: string } {
  if (s.lastSendStatus === "failed") return { label: "Gagal", cls: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" };
  if (!s.isActive) {
    if (s.frequency === "once" && s.lastSentAt)
      return { label: "Terkirim", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" };
    return { label: "Nonaktif", cls: "bg-muted text-muted-foreground" };
  }
  if (s.frequency === "once")
    return { label: "Aktif · Sekali kirim", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" };
  return { label: "Aktif · Berulang", cls: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" };
}

function scheduleSummary(s: ReportSchedule): string {
  if (s.frequency === "once") return "Sekali kirim";
  if (s.frequency === "weekly") return `Setiap ${formatRecurrenceDays(s.recurrenceDays)} jam ${s.sendTime}`;
  if (s.frequency === "monthly") return `Setiap tanggal 1 jam ${s.sendTime}`;
  return `Setiap hari jam ${s.sendTime}`;
}

export function ScheduleCard({ schedule, onEdit }: { schedule: ReportSchedule; onEdit: (s: ReportSchedule) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const toggleMut = useToggleReportSchedule();
  const sendMut = useSendReportScheduleNow();
  const deleteMut = useDeleteReportSchedule();
  const [expanded, setExpanded] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const badge = statusBadge(schedule);
  const refresh = () => qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() });

  const onToggle = async () => {
    try {
      await toggleMut.mutateAsync({ id: schedule.id, data: { isActive: !schedule.isActive } });
      await refresh();
    } catch {
      toast({ title: "Gagal mengubah status", variant: "destructive" });
    }
  };

  const onSend = async () => {
    setConfirmSend(false);
    try {
      await sendMut.mutateAsync({ id: schedule.id });
      toast({ title: "Pengiriman dimulai", description: "Laporan sedang diproses di latar belakang." });
    } catch {
      toast({ title: "Gagal memulai pengiriman", variant: "destructive" });
    }
  };

  const onDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteMut.mutateAsync({ id: schedule.id });
      toast({ title: "Jadwal dihapus." });
      await refresh();
    } catch {
      toast({ title: "Gagal menghapus jadwal", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium">{schedule.name}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Kirim ke: {schedule.recipientEmails.join(", ") || "—"}
            </p>
            <p className="text-xs text-muted-foreground">Jadwal: {scheduleSummary(schedule)}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {schedule.contentTypes.map((c) => (
                <Badge key={c} variant="outline" className="text-[10px]">
                  {CONTENT_TYPE_LABEL[c] ?? c}
                </Badge>
              ))}
            </div>
            {schedule.isActive && schedule.frequency !== "once" && schedule.nextScheduledAt && (
              <p className="mt-1 text-xs text-muted-foreground">Berikutnya: {formatDateTime(schedule.nextScheduledAt)}</p>
            )}
            {schedule.lastSendStatus === "failed" && schedule.lastSendError && (
              <p className="mt-1 text-xs text-red-600">Error terakhir: {schedule.lastSendError}</p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onEdit(schedule)}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={sendMut.isPending}
            onClick={() => setConfirmSend(true)}
          >
            <Send className="h-3.5 w-3.5" /> Kirim sekarang
          </Button>
          {schedule.frequency !== "once" && (
            <Button variant="outline" size="sm" className="gap-1.5" disabled={toggleMut.isPending} onClick={onToggle}>
              {schedule.isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {schedule.isActive ? "Nonaktifkan" : "Aktifkan"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-red-600 hover:text-red-700"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Hapus
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={() => setExpanded((v) => !v)}>
            Riwayat
            <ChevronDown className={expanded ? "h-3.5 w-3.5 rotate-180 transition-transform" : "h-3.5 w-3.5 transition-transform"} />
          </Button>
        </div>

        {expanded && (
          <div className="mt-3 border-t border-border pt-3">
            <ScheduleHistoryLog scheduleId={schedule.id} enabled={expanded} />
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kirim laporan sekarang?</AlertDialogTitle>
            <AlertDialogDescription>
              Laporan "{schedule.name}" akan langsung dibuat dan dikirim ke {schedule.recipientEmails.length} penerima.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={onSend}>Kirim</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus jadwal ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Jadwal "{schedule.name}" akan dihapus permanen. Laporan yang sudah terkirim tetap ada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete} className="bg-red-600 hover:bg-red-700">
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
