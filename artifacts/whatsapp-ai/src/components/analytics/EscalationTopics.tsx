import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { EscalationTopic } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

function barColor(rate: number): string {
  if (rate > 50) return "bg-red-500";
  if (rate >= 20) return "bg-amber-500";
  return "bg-green-500";
}

export function EscalationTopics({
  topics,
  loading,
}: {
  topics: EscalationTopic[] | undefined;
  loading?: boolean;
}) {
  const max = Math.max(1, ...(topics ?? []).map((t) => t.count));

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
            <Skeleton className="h-6 w-2/3" />
          </>
        ) : (topics ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Belum ada eskalasi yang bisa dikelompokkan pada periode ini.
          </p>
        ) : (
          topics!.map((t) => (
            <div key={t.topic}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="font-medium capitalize">{t.topic}</span>
                <span className="text-muted-foreground">
                  {t.count} · {t.escalationRate}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", barColor(t.escalationRate))}
                  style={{ width: `${Math.round((t.count / max) * 100)}%` }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
