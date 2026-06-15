import { useLocation } from "wouter";
import { useGetAiInsights, getGetAiInsightsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, Plus } from "lucide-react";

type InsightPeriod = "today" | "7d" | "30d";

interface KbRec {
  topic?: string;
  reason?: string;
  escalationRate?: number;
  estimatedImpact?: string;
}

export function KbRecommendations({ period }: { period: InsightPeriod }) {
  const [, navigate] = useLocation();
  const params = { type: "kb_recommendations" as const, period };
  const { data, isLoading } = useGetAiInsights(params, {
    query: { queryKey: getGetAiInsightsQueryKey(params) },
  });

  const recs = ((data?.content as { recommendations?: KbRec[] } | undefined)?.recommendations ?? []).filter((r) => r.topic);
  const err = data?.error;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          Rekomendasi tambahan Knowledge Base
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : err ? (
          <p className="text-muted-foreground">{err}</p>
        ) : recs.length === 0 ? (
          <p className="py-2 text-muted-foreground">Tidak ada rekomendasi — Knowledge Base sudah memadai.</p>
        ) : (
          recs.map((r, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {i + 1}. {r.topic}
                    {typeof r.escalationRate === "number" && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">— {r.escalationRate}% eskalasi</span>
                    )}
                  </p>
                  {r.reason && <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p>}
                  {r.estimatedImpact && <p className="mt-0.5 text-xs text-green-600">Estimasi dampak: {r.estimatedImpact}</p>}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 gap-1 text-xs"
                onClick={() => navigate(`/knowledge?topic=${encodeURIComponent(r.topic ?? "")}`)}
              >
                <Plus className="h-3 w-3" /> Tambahkan ke Knowledge Base
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
