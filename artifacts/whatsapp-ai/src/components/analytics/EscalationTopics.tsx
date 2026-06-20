import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { EscalationTopic } from "@workspace/api-client-react";

// Escalation-rate color zones: red >50% / amber 20-50% / green <20%.
function rateColor(rate: number): string {
  if (rate > 50) return "bg-red-500";
  if (rate >= 20) return "bg-amber-400";
  return "bg-green-500";
}

export function EscalationTopics({
  topics,
  loading,
}: {
  topics: EscalationTopic[] | undefined;
  loading?: boolean;
}) {
  // Show the top 5 by escalation rate.
  const rows = (topics ?? []).slice(0, 5);
  const maxCount = rows.reduce((m, t) => Math.max(m, t.count), 0) || 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Topik paling sering dieskalasi</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <>
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Belum ada topik eskalasi pada periode ini.
          </p>
        ) : (
          rows.map((t) => {
            const pct = Math.round((t.count / maxCount) * 100);
            return (
              <div key={t.topic}>
                <div className="mb-1 flex justify-between gap-2 text-xs">
                  <span className="truncate" title={t.topic}>
                    {t.topic}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {t.count} chat · {t.escalationRate}% eskalasi
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${rateColor(t.escalationRate)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
