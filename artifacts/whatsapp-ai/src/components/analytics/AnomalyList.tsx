import { useGetAiInsights, getGetAiInsightsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

type InsightPeriod = "today" | "7d" | "30d";

interface Anomaly {
  severity?: string;
  text?: string;
  ctaText?: string;
  category?: string;
}

const DOT: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
};

export function AnomalyList({ period }: { period: InsightPeriod }) {
  const params = { type: "anomaly" as const, period };
  const { data, isLoading } = useGetAiInsights(params, {
    query: { queryKey: getGetAiInsightsQueryKey(params) },
  });

  const anomalies = ((data?.content as { anomalies?: Anomaly[] } | undefined)?.anomalies ?? []).filter((a) => a.text);
  const err = data?.error;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          Deteksi anomali otomatis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {isLoading ? (
          <>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </>
        ) : err ? (
          <p className="text-muted-foreground">{err}</p>
        ) : anomalies.length === 0 ? (
          <p className="py-2 text-muted-foreground">Tidak ada anomali signifikan terdeteksi 👍</p>
        ) : (
          anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2">
              <span className={cn("mt-1.5 h-2 w-2 flex-shrink-0 rounded-full", DOT[a.severity ?? "info"] ?? "bg-muted")} />
              <span className="flex-1">{a.text}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
