import { useState, useMemo } from "react";
import type { WorkboardColumn, WorkboardTask, WorkboardMember } from "@/hooks/useBoardDetail";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Trash2, Calendar, AlertCircle } from "lucide-react";
import { format, isToday, isPast, parseISO } from "date-fns";
import TaskModal from "../TaskModal";
import BoardFilterBar, { EMPTY_FILTER, type BoardFilterState } from "../BoardFilterBar";
import { matchesFilter } from "../board-filter";
import { useGetMe } from "@workspace/api-client-react";

type FilterTab = "all" | "today" | "done";

interface TodoViewProps {
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  canEdit: boolean;
  myRole?: "owner" | "editor" | "viewer" | null;
  onCreateTask: (data: {
    title: string;
    columnId?: number | null;
  }) => Promise<void>;
  onUpdateTask: (taskId: number, data: Partial<WorkboardTask> & { assigneeIds?: number[] }) => Promise<void>;
  onDeleteTask: (taskId: number) => Promise<void>;
  onToggleComplete: (taskId: number, isCompleted: boolean) => Promise<void>;
}

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-slate-100 text-slate-600",
};
const PRIORITY_LABELS: Record<string, string> = {
  high: "T",
  medium: "S",
  low: "R",
};

export default function TodoView({
  columns,
  tasks,
  members,
  canEdit,
  myRole = null,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onToggleComplete,
}: TodoViewProps) {
  const { data: me } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const myUserId = me?.user?.id ?? null;
  const [filter, setFilter] = useState<FilterTab>("all");
  const [boardFilter, setBoardFilter] = useState<BoardFilterState>(EMPTY_FILTER);
  const [quickAdd, setQuickAdd] = useState<Record<number, string>>({});
  const [taskModal, setTaskModal] = useState<{ open: boolean; task?: WorkboardTask | null }>({ open: false });

  function applyFilter(task: WorkboardTask): boolean {
    if (filter === "done") return task.isCompleted;
    if (filter === "today") return !task.isCompleted && !!task.dueDate && isToday(parseISO(task.dueDate));
    return true;
  }

  const filteredTasks = useMemo(
    () => tasks.filter(applyFilter).filter((t) => matchesFilter(t, boardFilter)),
    [tasks, filter, boardFilter]
  );

  // Group by column, null column at end
  const grouped = useMemo(() => {
    const byCol: Record<string, WorkboardTask[]> = {};
    for (const task of filteredTasks) {
      const key = task.columnId !== null ? String(task.columnId) : "__null";
      if (!byCol[key]) byCol[key] = [];
      byCol[key].push(task);
    }
    return byCol;
  }, [filteredTasks]);

  async function handleQuickAdd(columnId: number | null, key: string) {
    const title = quickAdd[columnId ?? 0]?.trim();
    if (!title) return;
    await onCreateTask({ title, columnId });
    setQuickAdd((prev) => ({ ...prev, [columnId ?? 0]: "" }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 border rounded-lg p-1 w-fit">
          {(["all", "today", "done"] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                filter === tab
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "all" ? "Semua" : tab === "today" ? "Hari Ini" : "Selesai"}
            </button>
          ))}
        </div>
        <BoardFilterBar
          tasks={tasks}
          members={members}
          currentUserId={myUserId}
          value={boardFilter}
          onChange={setBoardFilter}
        />
      </div>

      <div className="space-y-6">
        {columns.map((col) => {
          const colTasks = (grouped[String(col.id)] ?? []).sort((a, b) => a.position - b.position);
          const nullTasks = (grouped["__null"] ?? []).sort((a, b) => a.position - b.position);

          if (col !== columns[0] && colTasks.length === 0 && !canEdit) return null;

          return (
            <div key={col.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col.color }} />
                <span className="font-semibold text-sm">{col.name}</span>
                <span className="text-xs text-muted-foreground">({colTasks.length})</span>
              </div>

              <div className="space-y-1 pl-4">
                {colTasks.map((task) => (
                  <TodoRow
                    key={task.id}
                    task={task}
                    canEdit={canEdit}
                    onClick={() => setTaskModal({ open: true, task })}
                    onToggle={() => onToggleComplete(task.id, !task.isCompleted)}
                    onDelete={() => onDeleteTask(task.id)}
                  />
                ))}

                {canEdit && (
                  <div className="flex gap-2 mt-1">
                    <Input
                      className="h-8 text-sm"
                      placeholder="Tambah task baru... (Enter)"
                      value={quickAdd[col.id] ?? ""}
                      onChange={(e) =>
                        setQuickAdd((prev) => ({ ...prev, [col.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleQuickAdd(col.id, String(col.id));
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Uncategorized */}
        {(grouped["__null"]?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground" />
              <span className="font-semibold text-sm">Tanpa Kategori</span>
            </div>
            <div className="space-y-1 pl-4">
              {(grouped["__null"] ?? []).map((task) => (
                <TodoRow
                  key={task.id}
                  task={task}
                  canEdit={canEdit}
                  onClick={() => setTaskModal({ open: true, task })}
                  onToggle={() => onToggleComplete(task.id, !task.isCompleted)}
                  onDelete={() => onDeleteTask(task.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <TaskModal
        open={taskModal.open}
        onClose={() => setTaskModal({ open: false })}
        task={taskModal.task}
        columns={columns}
        members={members}
        readOnly={!canEdit}
        myRole={myRole}
        onSave={async (data) => {
          if (taskModal.task) {
            await onUpdateTask(taskModal.task.id, data);
          } else {
            await onCreateTask(data);
          }
        }}
        onDelete={taskModal.task ? () => onDeleteTask(taskModal.task!.id) : undefined}
      />
    </div>
  );
}

function TodoRow({
  task,
  canEdit,
  onClick,
  onToggle,
  onDelete,
}: {
  task: WorkboardTask;
  canEdit: boolean;
  onClick: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const isOverdue = task.dueDate && !task.isCompleted && isPast(parseISO(task.dueDate));

  return (
    <div className="flex items-center gap-2 group py-1 px-2 rounded hover:bg-muted/40">
      <Checkbox
        checked={task.isCompleted}
        onCheckedChange={canEdit ? onToggle : undefined}
        disabled={!canEdit}
      />
      <span
        className={`flex-1 text-sm cursor-pointer hover:text-primary transition-colors ${
          task.isCompleted ? "line-through text-muted-foreground" : ""
        }`}
        onClick={onClick}
      >
        {task.title}
      </span>

      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
          PRIORITY_STYLES[task.priority] ?? ""
        }`}
      >
        {PRIORITY_LABELS[task.priority] ?? "?"}
      </span>

      {task.dueDate && (
        <span
          className={`flex items-center gap-0.5 text-[10px] whitespace-nowrap ${
            isOverdue ? "text-red-500" : "text-muted-foreground"
          }`}
        >
          {isOverdue ? <AlertCircle className="w-3 h-3" /> : <Calendar className="w-3 h-3" />}
          {format(parseISO(task.dueDate), "d MMM")}
        </span>
      )}

      {task.assignees.length > 0 && (
        <div className="flex -space-x-1">
          {task.assignees.slice(0, 2).map((a) => (
            <div
              key={a.userId}
              className="w-4 h-4 rounded-full bg-primary/20 border border-background flex items-center justify-center text-[8px] font-bold"
              title={a.name ?? a.email ?? ""}
            >
              {(a.name ?? a.email ?? "?").slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}
