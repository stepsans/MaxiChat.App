import { useLocation } from "wouter";
import { useGetNextActions, getGetNextActionsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

type Ctx = "summary" | "ai" | "history" | "schedule";

const DOT: Record<string, string> = {
  red: "bg-red-500",
  yellow: "bg-amber-500",
  blue: "bg-blue-500",
};

/**
 * "Apa yang perlu dilakukan sekarang?" — contextual action list from
 * /analytics/v2/next-actions. Polls every 60s so urgent items stay fresh.
 */
export function NextActionBox({ context }: { context: Ctx }) {
  const [, navigate] = useLocation();
  const params = { context };
  const { data, isLoading } = useGetNextActions(params, {
    query: { queryKey: getGetNextActionsQueryKey(params), refetchInterval: 60_000 },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-amber-500" />
          Apa yang perlu dilakukan sekarang?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </>
        ) : (
          (data ?? []).map((item, i) => (
            <div key={i} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
              <span className={cn("h-2 w-2 flex-shrink-0 rounded-full", DOT[item.severity] ?? "bg-muted")} />
              <span className="flex-1 text-sm">{item.text}</span>
              {item.ctaText && item.ctaRoute && (
                <button
                  type="button"
                  className="flex-shrink-0 text-xs font-medium text-primary hover:underline"
                  onClick={() => navigate(item.ctaRoute as string)}
                >
                  {item.ctaText} →
                </button>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
