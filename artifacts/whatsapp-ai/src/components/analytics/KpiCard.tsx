import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";

export type KpiUrgency = "normal" | "warning" | "danger";

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Percent change vs previous period; sign drives the arrow. */
  change?: number | null;
  /** When true, a positive change is GOOD (green up). For metrics where lower
   *  is better (response time, escalations) pass false to flip the colors. */
  higherIsBetter?: boolean;
  urgency?: KpiUrgency;
  loading?: boolean;
  onClick?: () => void;
}

export function KpiCard({
  label,
  value,
  sub,
  change,
  higherIsBetter = true,
  urgency = "normal",
  loading,
  onClick,
}: KpiCardProps) {
  const up = (change ?? 0) > 0;
  const good = change == null || change === 0 ? null : up === higherIsBetter;
  const changeColor = good == null ? "text-muted-foreground" : good ? "text-green-600" : "text-red-600";

  return (
    <Card
      className={cn(
        onClick && "cursor-pointer transition-colors hover:border-primary/50",
        urgency === "danger" && "border-red-300 dark:border-red-900/60",
        urgency === "warning" && "border-amber-300 dark:border-amber-900/60",
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        )}
        <div className="mt-1 flex items-center gap-1 text-xs">
          {change != null && change !== 0 && !loading && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", changeColor)}>
              {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {Math.abs(change)}%
            </span>
          )}
          {sub && <span className="text-muted-foreground">{sub}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
