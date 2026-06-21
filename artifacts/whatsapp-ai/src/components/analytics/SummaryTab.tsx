import { useLocation } from "wouter";
import { useGetAnalyticsV2Summary, getGetAnalyticsV2SummaryQueryKey } from "@workspace/api-client-react";
import { InfoBar } from "./InfoBar";
import { KpiCard } from "./KpiCard";
import { NextActionBox } from "./NextActionBox";
import { ChannelDistributionChart } from "./ChannelDistributionChart";
import { SatisfactionBars } from "./SatisfactionBars";
import { formatDurationSeconds, type PeriodKey } from "./format";

export function SummaryTab({ period, from, to, channel }: { period: PeriodKey; from?: string; to?: string; channel?: number }) {
  const [, navigate] = useLocation();
  const params = { period, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(channel != null ? { channel } : {}) };
  const { data, isLoading } = useGetAnalyticsV2Summary(params, {
    query: { queryKey: getGetAnalyticsV2SummaryQueryKey(params) },
  });

  // Deep-link into the Riwayat Chat tab with a pre-applied filter.
  const goHistory = (filter?: string) => navigate(`/analytics?tab=history${filter ? `&${filter}` : ""}`);

  return (
    <div className="space-y-4">
      <InfoBar
        dismissKey="summary"
        text="Ini ringkasan performa tim untuk periode terpilih. Klik kartu mana pun untuk melihat detail di tab Riwayat Chat. Gunakan tab di atas untuk analisa AI, riwayat percakapan, atau mengatur jadwal laporan otomatis."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Total chat masuk"
          value={isLoading ? "" : String(data?.totalChats ?? 0)}
          change={data?.totalChatsChange}
          loading={isLoading}
          onClick={() => goHistory()}
        />
        <KpiCard
          label="Ditangani AI"
          value={isLoading ? "" : `${data?.aiHandledRate ?? 0}%`}
          sub={data ? `${data.aiHandledCount} dari ${data.totalChats}` : undefined}
          loading={isLoading}
          onClick={() => goHistory("hHandled=ai")}
        />
        <KpiCard
          label="Avg. waktu respons"
          value={isLoading ? "" : formatDurationSeconds(data?.avgResponseTimeSeconds ?? 0)}
          change={data?.avgResponseTimeChange}
          higherIsBetter={false}
          loading={isLoading}
        />
        <KpiCard
          label="Belum dibalas"
          value={isLoading ? "" : String(data?.unrepliedCount ?? 0)}
          sub=">30 menit"
          urgency={(data?.unrepliedCount ?? 0) > 0 ? "danger" : "normal"}
          loading={isLoading}
          onClick={() => goHistory("hStatus=unreplied")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChannelDistributionChart data={data?.channelBreakdown} loading={isLoading} />
        <SatisfactionBars data={data?.satisfactionBreakdown} hasData={data?.hasSatisfactionData} loading={isLoading} />
      </div>

      <NextActionBox context="summary" />
    </div>
  );
}
