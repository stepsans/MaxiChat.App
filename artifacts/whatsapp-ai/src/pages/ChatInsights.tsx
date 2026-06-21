import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare,
  Clock,
  Bot,
  Inbox,
  ChevronLeft,
  Printer,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";
import { useDashboardTier2Chat } from "@/hooks/useDashboard";
import {
  rangeForPreset,
  isLivePreset,
  PRESET_LABELS,
  type RangePreset,
} from "@/components/dashboard/dashboard-range";

const PRESETS: RangePreset[] = ["today", "7d", "month"];

function fmtFrt(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function Tile({
  label,
  value,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  tone?: "primary" | "success" | "warning" | "muted";
}) {
  const toneCls: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-bold mt-1 text-foreground tabular-nums">{value}</p>
        </div>
        <div className={cn("p-2 rounded-md flex-shrink-0", toneCls[tone])}>
          <Icon className="w-4 h-4" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function ChatInsights() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.dashboard?.canView;
  const [, navigate] = useLocation();
  const [preset, setPreset] = useState<RangePreset>("today");
  const range = useMemo(() => rangeForPreset(preset), [preset]);
  const live = isLivePreset(preset);
  const { data, isLoading } = useDashboardTier2Chat(range, live);

  if (!permLoading && !canView) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Anda tidak memiliki izin untuk melihat dashboard ini.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const maxHour = (data?.volume_by_hour ?? []).reduce((m, r) => Math.max(m, r.count), 0) || 1;
  const aih = data?.ai_vs_human ?? { ai: 0, human: 0 };
  const aihTotal = aih.ai + aih.human;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="gap-1 text-muted-foreground print:hidden">
            <ChevronLeft className="w-4 h-4" />
            Dashboard
          </Button>
          <h1 className="text-base font-semibold text-foreground truncate">Dashboard Chat</h1>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 print:hidden">
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                className={cn(
                  "px-2.5 py-1 font-medium transition-colors",
                  preset === p ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent/40"
                )}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()}>
            <Printer className="w-3.5 h-3.5" />
            Print
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {isLoading || !data ? (
            Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)
          ) : (
            <>
              <Tile label="Percakapan" value={data.kpi.percakapan.count} icon={MessageSquare} tone="primary" />
              <Tile label="Avg Balas Pertama" value={fmtFrt(data.kpi.avg_frt_seconds)} icon={Clock} tone="muted" />
              <Tile
                label="Ditangani AI"
                value={data.kpi.ai_handled_percent != null ? `${data.kpi.ai_handled_percent}%` : "—"}
                icon={Bot}
                tone="success"
              />
              <Tile label="Belum Dibalas" value={data.kpi.belum_dibalas} icon={Inbox} tone="warning" />
            </>
          )}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Volume Chat Masuk per Jam</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-40 rounded-lg" />
            ) : (
              <div className="flex items-end gap-1 h-40">
                {data.volume_by_hour.map((b) => (
                  <div key={b.hour} className="flex-1 flex flex-col items-center gap-1 group">
                    <div className="w-full flex items-end h-32">
                      <div
                        className="w-full rounded-t bg-primary transition-all group-hover:bg-primary/80"
                        style={{ height: `${Math.max(2, Math.round((b.count / maxHour) * 100))}%` }}
                        title={`${b.hour}:00 — ${b.count}`}
                      />
                    </div>
                    {b.hour % 3 === 0 && (
                      <span className="text-[9px] text-muted-foreground tabular-nums">{b.hour}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Distribusi Balasan: AI vs Manusia</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : aihTotal === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada balasan keluar pada periode ini.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
                  <div className="bg-primary" style={{ width: `${Math.round((aih.ai / aihTotal) * 100)}%` }} />
                  <div className="bg-success" style={{ width: `${Math.round((aih.human / aihTotal) * 100)}%` }} />
                </div>
                <div className="flex items-center gap-6 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-2.5 h-2.5 rounded-full bg-primary" />
                    AI — {aih.ai} ({Math.round((aih.ai / aihTotal) * 100)}%)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
                    Manusia — {aih.human} ({Math.round((aih.human / aihTotal) * 100)}%)
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
