import { useGetAiPerformance, getGetAiPerformanceQueryKey } from "@workspace/api-client-react";
import { InfoBar } from "./InfoBar";
import { KpiCard } from "./KpiCard";
import { NextActionBox } from "./NextActionBox";
import { AiInsightCard } from "./AiInsightCard";
import { AnomalyList } from "./AnomalyList";
import { KbRecommendations } from "./KbRecommendations";
import { EscalationTopics } from "./EscalationTopics";
import type { PeriodKey } from "./format";

type InsightPeriod = "today" | "7d" | "30d";

export function AiAnalysisTab({ period, from, to, channel }: { period: PeriodKey; from?: string; to?: string; channel?: number }) {
  const params = { period, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(channel != null ? { channel } : {}) };
  const { data, isLoading } = useGetAiPerformance(params, {
    query: { queryKey: getGetAiPerformanceQueryKey(params) },
  });

  // ai-insights endpoint only supports today/7d/30d — map custom to 30d.
  const insightPeriod: InsightPeriod = period === "custom" ? "30d" : period;

  return (
    <div className="space-y-4">
      <InfoBar
        dismissKey="ai"
        text="Menampilkan seberapa efektif AI menangani percakapan — tingkat penyelesaian, eskalasi ke agent, dan rekomendasi perbaikan. Ini tentang performa AI dalam melayani customer Anda, bukan tentang AI itu sendiri."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Diselesaikan AI" value={isLoading ? "" : `${data?.resolvedByAi ?? 0}%`} loading={isLoading} />
        <KpiCard
          label="Dieskalasi ke agent"
          value={isLoading ? "" : `${data?.escalatedToAgent ?? 0}%`}
          sub={data ? `${data.escalatedCount} chat` : undefined}
          change={data?.escalatedChange}
          higherIsBetter={false}
          urgency={(data?.escalatedChange ?? 0) > 20 ? "warning" : "normal"}
          loading={isLoading}
        />
        <KpiCard
          label="Avg. panjang sesi AI"
          value={isLoading ? "" : `${data?.avgSessionLength ?? 0} pesan`}
          loading={isLoading}
        />
        <KpiCard
          label="Token AI dipakai"
          value={isLoading ? "" : (data?.tokensUsed ?? 0).toLocaleString("id-ID")}
          sub={data ? (data.tokensRemaining < 0 ? "tak terbatas" : `sisa ${data.tokensRemaining.toLocaleString("id-ID")}`) : undefined}
          loading={isLoading}
        />
      </div>

      {channel != null && (
        <p className="text-xs text-muted-foreground">
          Insight AI, deteksi anomali & rekomendasi KB di bawah dihitung untuk semua channel (bukan channel terpilih).
        </p>
      )}

      <EscalationTopics topics={data?.topEscalationTopics} loading={isLoading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <AiInsightCard period={insightPeriod} />
        <AnomalyList period={insightPeriod} />
      </div>

      <KbRecommendations period={insightPeriod} />

      <NextActionBox context="ai" />
    </div>
  );
}
