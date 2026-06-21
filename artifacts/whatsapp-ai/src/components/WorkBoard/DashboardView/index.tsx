import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ListTodo,
  AlertTriangle,
  Clock,
  CheckCircle2,
  UserX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  WorkboardColumn,
  WorkboardTask,
  WorkboardMember,
} from "@/hooks/useBoardDetail";

const DUE_SOON_DAYS = 3;

function StatTile({
  label,
  value,
  icon: Icon,
  tone = "muted",
  testId,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  tone?: "primary" | "destructive" | "warning" | "success" | "muted";
  testId?: string;
}) {
  const toneCls: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    destructive: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
    success: "bg-success/10 text-success",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4 flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            {label}
          </p>
          <p className="text-2xl font-bold mt-1 text-foreground tabular-nums">{value}</p>
        </div>
        <div className={cn("p-2 rounded-md flex-shrink-0", toneCls[tone])}>
          <Icon className="w-4 h-4" />
        </div>
      </CardContent>
    </Card>
  );
}

function RankBars({
  rows,
}: {
  rows: { label: string; count: number; color?: string }[];
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Tidak ada data.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground truncate flex items-center gap-1.5">
              {r.color && (
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: r.color }}
                />
              )}
              {r.label}
            </span>
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

// Tier-2 WorkBoard dashboard (spec A.10) — computed client-side from the board
// detail already loaded by useBoardDetail. No extra backend call needed.
export default function DashboardView({
  columns,
  tasks,
  members,
}: {
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
}) {
  const stats = useMemo(() => {
    const now = Date.now();
    const soonCutoff = now + DUE_SOON_DAYS * 24 * 60 * 60 * 1000;

    let completed = 0;
    let overdue = 0;
    let dueSoon = 0;
    let unassigned = 0;
    const overdueTasks: WorkboardTask[] = [];

    for (const t of tasks) {
      if (t.isCompleted) completed++;
      if (t.assignees.length === 0) unassigned++;
      if (!t.isCompleted && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (due < now) {
          overdue++;
          overdueTasks.push(t);
        } else if (due <= soonCutoff) {
          dueSoon++;
        }
      }
    }

    // Task per column (+ a bucket for tasks with no column).
    const colCount = new Map<number | null, number>();
    for (const t of tasks) colCount.set(t.columnId, (colCount.get(t.columnId) ?? 0) + 1);
    const perColumn = columns
      .map((c) => ({ label: c.name, count: colCount.get(c.id) ?? 0, color: c.color }))
      .concat(
        (colCount.get(null) ?? 0) > 0
          ? [{ label: "Tanpa kolom", count: colCount.get(null) ?? 0, color: "#94a3b8" }]
          : []
      )
      .sort((a, b) => b.count - a.count);

    // Load per assignee (incomplete tasks only).
    const nameById = new Map<number, string>();
    for (const m of members) nameById.set(m.userId, m.name || m.email || `User ${m.userId}`);
    const loadByUser = new Map<number, number>();
    for (const t of tasks) {
      if (t.isCompleted) continue;
      for (const a of t.assignees) loadByUser.set(a.userId, (loadByUser.get(a.userId) ?? 0) + 1);
    }
    const perAssignee = [...loadByUser.entries()]
      .map(([userId, count]) => ({
        label: nameById.get(userId) ?? `User ${userId}`,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    overdueTasks.sort((a, b) => {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : 0;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : 0;
      return da - db;
    });

    return {
      total: tasks.length,
      completed,
      overdue,
      dueSoon,
      unassigned,
      perColumn,
      perAssignee,
      overdueTasks,
    };
  }, [columns, tasks, members]);

  return (
    <div className="space-y-6 pb-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatTile label="Total Task" value={stats.total} icon={ListTodo} tone="primary" testId="wb-total" />
        <StatTile label="Overdue" value={stats.overdue} icon={AlertTriangle} tone="destructive" testId="wb-overdue" />
        <StatTile label="Due Soon" value={stats.dueSoon} icon={Clock} tone="warning" testId="wb-due-soon" />
        <StatTile label="Selesai" value={stats.completed} icon={CheckCircle2} tone="success" testId="wb-completed" />
        <StatTile label="Belum di-assign" value={stats.unassigned} icon={UserX} tone="muted" testId="wb-unassigned" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card data-testid="wb-per-column">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Task per Kolom</CardTitle>
          </CardHeader>
          <CardContent>
            <RankBars rows={stats.perColumn} />
          </CardContent>
        </Card>

        <Card data-testid="wb-per-assignee">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Beban per Assignee</CardTitle>
          </CardHeader>
          <CardContent>
            <RankBars rows={stats.perAssignee} />
          </CardContent>
        </Card>
      </div>

      <Card data-testid="wb-overdue-list">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            Task Overdue ({stats.overdueTasks.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats.overdueTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada task overdue. 🎉</p>
          ) : (
            <div className="divide-y divide-border">
              {stats.overdueTasks.slice(0, 20).map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 gap-3">
                  <span className="text-sm font-medium text-foreground truncate">{t.title}</span>
                  <span className="text-xs text-destructive tabular-nums flex-shrink-0">
                    {t.dueDate ? new Date(t.dueDate).toLocaleDateString("id-ID") : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
