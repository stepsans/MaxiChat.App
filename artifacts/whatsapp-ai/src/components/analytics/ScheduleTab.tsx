import { useState } from "react";
import {
  useListReportSchedules,
  getListReportSchedulesQueryKey,
  type ReportSchedule,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, CalendarClock } from "lucide-react";
import { InfoBar } from "./InfoBar";
import { NextActionBox } from "./NextActionBox";
import { ScheduleCard } from "./ScheduleCard";
import { ScheduleWizardModal } from "./ScheduleWizardModal";

export function ScheduleTab() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<ReportSchedule | null>(null);

  const { data, isLoading } = useListReportSchedules({
    query: { queryKey: getListReportSchedulesQueryKey() },
  });

  const openCreate = () => {
    setEditing(null);
    setWizardOpen(true);
  };
  const openEdit = (s: ReportSchedule) => {
    setEditing(s);
    setWizardOpen(true);
  };

  return (
    <div className="space-y-4">
      <InfoBar
        dismissKey="schedule"
        text="Atur laporan performa tim dikirim otomatis ke email. Pilih konten laporan, tujuan pengiriman, dan frekuensinya. Jadwal yang sudah dibuat tampil di bawah — klik untuk edit atau kirim sekarang."
      />

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Jadwal Aktif</h2>
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Buat Jadwal Baru
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (data ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CalendarClock className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Belum ada jadwal laporan. Buat jadwal pertama agar tim selalu update.
            </p>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-4 w-4" /> Buat Jadwal Baru
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data!.map((s) => (
            <ScheduleCard key={s.id} schedule={s} onEdit={openEdit} />
          ))}
        </div>
      )}

      <NextActionBox context="schedule" />

      <ScheduleWizardModal open={wizardOpen} onOpenChange={setWizardOpen} editing={editing} />
    </div>
  );
}
