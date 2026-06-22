import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Kanban,
  AlertTriangle,
  Clock,
  CheckCircle2,
  UserX,
  ChevronLeft,
  Printer,
  ShieldAlert,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";
import { useDashboardTier2Workboard } from "@/hooks/useDashboard";

// WorkBoard Tier-2 dashboard (spec A.10): task KPIs + per-column + per-assignee
// load + overdue list, with board/assignee filters. Reached from the Dashboard
// "WorkBoard" module tile.

function Tile({
  label,
  value,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  tone?: "primary" | "destructive" | "warning" | "success" | "muted";
}) {
  const toneCls: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    destructive: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
    success: "bg-success/10 text-success",
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

function BarRows({ rows }: { rows: { label: string; count: number }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">Tidak ada data.</p>;
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">{r.count}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.round((r.count / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtDue(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(
    d.getUTCHours()
  ).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export default function WorkboardInsights() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.dashboard?.canView;
  const [, navigate] = useLocation();
  const [board, setBoard] = useState<number | undefined>(undefined);
  const [assignee, setAssignee] = useState<number | undefined>(undefined);
  const { data, isLoading } = useDashboardTier2Workboard(board, assignee);

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

  const kpi = data?.kpi;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
            className="gap-1 text-muted-foreground print:hidden"
          >
            <ChevronLeft className="w-4 h-4" />
            Dashboard
          </Button>
          <h1 className="text-base font-semibold text-foreground truncate">Dashboard WorkBoard</h1>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 print:hidden">
          <Select
            value={board ? String(board) : "all"}
            onValueChange={(v) => setBoard(v === "all" ? undefined : Number(v))}
          >
            <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="workboard-filter-board">
              <SelectValue placeholder="Semua board" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                Semua board
              </SelectItem>
              {(data?.boards ?? []).map((b) => (
                <SelectItem key={b.id} value={String(b.id)} className="text-xs">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={assignee ? String(assignee) : "all"}
            onValueChange={(v) => setAssignee(v === "all" ? undefined : Number(v))}
          >
            <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="workboard-filter-assignee">
              <SelectValue placeholder="Semua assignee" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                Semua assignee
              </SelectItem>
              {(data?.per_assignee ?? []).map((a) => (
                <SelectItem key={a.userId} value={String(a.userId)} className="text-xs">
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()}>
            <Printer className="w-3.5 h-3.5" />
            Print
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {isLoading || !kpi ? (
            Array(5)
              .fill(0)
              .map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)
          ) : (
            <>
              <Tile label="Total Task" value={kpi.total} icon={Kanban} tone="primary" />
              <Tile label="Overdue" value={kpi.overdue} icon={AlertTriangle} tone="destructive" />
              <Tile label="Due Soon" value={kpi.due_soon} icon={Clock} tone="warning" />
              <Tile label="Selesai" value={kpi.selesai} icon={CheckCircle2} tone="success" />
              <Tile label="Belum Di-assign" value={kpi.unassigned} icon={UserX} tone="muted" />
            </>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Task per Kolom</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading || !data ? (
                <Skeleton className="h-32 rounded-lg" />
              ) : (
                <BarRows rows={data.per_column.map((r) => ({ label: r.column, count: r.count }))} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Beban per Assignee</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading || !data ? (
                <Skeleton className="h-32 rounded-lg" />
              ) : (
                <BarRows rows={data.per_assignee.map((r) => ({ label: r.name, count: r.count }))} />
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Task Overdue
              {data && (
                <span className="text-xs font-normal text-muted-foreground">({data.overdue_list.length})</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-24 rounded-lg" />
            ) : data.overdue_list.length === 0 ? (
              <p className="text-sm text-muted-foreground">Tidak ada task overdue. 🎉</p>
            ) : (
              <div className="divide-y divide-border">
                {data.overdue_list.map((t) => (
                  <div key={t.taskId} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{t.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t.board}
                        {t.assignees.length > 0 ? ` · ${t.assignees.join(", ")}` : " · belum di-assign"}
                      </p>
                    </div>
                    <span className="text-xs tabular-nums text-destructive flex-shrink-0">
                      {fmtDue(t.dueDate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
