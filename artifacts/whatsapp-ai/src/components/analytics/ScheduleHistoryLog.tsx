import {
  useListReportScheduleLogs,
  getListReportScheduleLogsQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { formatDateTime } from "./format";

const STATUS_ICON = {
  sent: <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />,
  failed: <XCircle className="h-3.5 w-3.5 text-red-600" />,
  pending: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
};

/** Recent delivery attempts for one schedule (lazy — only fetches when shown). */
export function ScheduleHistoryLog({ scheduleId, enabled }: { scheduleId: number; enabled: boolean }) {
  const params = { limit: 10 };
  const { data, isLoading } = useListReportScheduleLogs(scheduleId, params, {
    query: { queryKey: getListReportScheduleLogsQueryKey(scheduleId, params), enabled },
  });

  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (!data || data.length === 0)
    return <p className="px-1 py-2 text-xs text-muted-foreground">Belum ada riwayat pengiriman.</p>;

  return (
    <div className="space-y-1">
      {data.map((l) => (
        <div key={l.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs">
          {STATUS_ICON[l.status as keyof typeof STATUS_ICON] ?? STATUS_ICON.pending}
          <span className="text-muted-foreground">{formatDateTime(l.createdAt)}</span>
          <span className="ml-auto">
            {l.status === "sent" ? "Terkirim" : l.status === "failed" ? "Gagal" : "Menunggu"}
            {l.triggeredBy === "manual" && " · manual"}
          </span>
          {l.status === "failed" && l.errorMessage && (
            <span className="max-w-[200px] truncate text-red-600" title={l.errorMessage}>
              {l.errorMessage}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
