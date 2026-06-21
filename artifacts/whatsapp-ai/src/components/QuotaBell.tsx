import { Link } from "wouter";
import {
  useGetMyAiUsage,
  getGetMyAiUsageQueryKey,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { quotaTone, fmtNum } from "@/lib/quota-display";
import { Bell } from "lucide-react";

// Global token-quota bell (spec E1/E2). Lights up at 80/5/0% with a coloured dot
// and a CTA to the Pemakaian Token page. Driven live by /ai-usage/me polling, so
// no separate notification feed is needed for the in-app channel.
export function QuotaBell() {
  const { menus } = usePermissions();
  const canView = menus.usage.canView;

  const { data } = useGetMyAiUsage({
    query: {
      queryKey: getGetMyAiUsageQueryKey(),
      refetchInterval: 60_000,
      enabled: canView,
      retry: false,
    },
  });

  if (!canView || !data) return null;
  const level = data.notifyLevel;
  const active = level !== "ok" && (data.tokenLimit ?? 0) > 0;
  const tone = quotaTone(level);
  const pct = Math.min(100, data.usagePercent ?? 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label="Status kuota token"
          data-testid="quota-bell"
        >
          <Bell className="w-4 h-4" />
          {active && (
            <span
              className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full ring-2 ring-background ${tone.dot}`}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Kuota Token AI</span>
            <span className={`text-xs ${tone.text}`}>{tone.label}</span>
          </div>
          {(data.tokenLimit ?? 0) <= 0 ? (
            <p className="text-sm text-muted-foreground">
              {data.isInfinity ? "Tanpa batas (Infinity)." : "Belum ada plafon kuota."}
            </p>
          ) : (
            <>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${tone.bar}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Sisa {fmtNum(data.tokenRemaining)} dari {fmtNum(data.tokenLimit)} token
                {data.projectedDaysRemaining != null
                  ? ` · estimasi habis ~${data.projectedDaysRemaining} hari`
                  : ""}
                .
              </p>
              {active && (
                <Link href="/usage">
                  <Button size="sm" className="w-full mt-1">
                    Tambah Kuota / Beli Booster
                  </Button>
                </Link>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
