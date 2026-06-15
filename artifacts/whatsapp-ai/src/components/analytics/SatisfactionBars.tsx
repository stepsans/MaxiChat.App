import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SatisfactionBreakdown } from "@workspace/api-client-react";

const ROWS: Array<{ key: keyof SatisfactionBreakdown; label: string; color: string }> = [
  { key: "very_satisfied", label: "Sangat puas", color: "bg-green-500" },
  { key: "satisfied", label: "Puas", color: "bg-emerald-400" },
  { key: "neutral", label: "Netral", color: "bg-amber-400" },
  { key: "unsatisfied", label: "Tidak puas", color: "bg-red-500" },
];

export function SatisfactionBars({
  data,
  hasData,
  loading,
}: {
  data: SatisfactionBreakdown | undefined;
  hasData: boolean | undefined;
  loading?: boolean;
}) {
  const total = data ? ROWS.reduce((s, r) => s + (data[r.key] || 0), 0) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Skor kepuasan customer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <>
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </>
        ) : !hasData || total === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Belum ada rating kepuasan pada periode ini.
          </p>
        ) : (
          ROWS.map((r) => {
            const v = data![r.key] || 0;
            const pct = total > 0 ? Math.round((v / total) * 100) : 0;
            return (
              <div key={r.key}>
                <div className="mb-1 flex justify-between text-xs">
                  <span>{r.label}</span>
                  <span className="text-muted-foreground">
                    {v} · {pct}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${r.color}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
