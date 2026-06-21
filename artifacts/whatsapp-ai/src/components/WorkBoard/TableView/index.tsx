import { useState, useMemo } from "react";
import type { WorkboardColumn, WorkboardTask, WorkboardMember } from "@/hooks/useBoardDetail";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Trash2, ChevronUp, ChevronDown, ArrowUpDown } from "lucide-react";
import { format, isPast, parseISO } from "date-fns";
import TaskModal from "../TaskModal";
import BoardFilterBar, { EMPTY_FILTER, type BoardFilterState } from "../BoardFilterBar";
import { matchesFilter } from "../board-filter";
import { useGetMe } from "@workspace/api-client-react";

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-slate-100 text-slate-600",
};
const PRIORITY_LABELS: Record<string, string> = {
  high: "Tinggi",
  medium: "Sedang",
  low: "Rendah",
};
const PAGE_SIZE = 20;

type SortKey = "title" | "priority" | "dueDate" | "columnId";
type SortDir = "asc" | "desc";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

interface TableViewProps {
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  canEdit: boolean;
  myRole?: "owner" | "editor" | "viewer" | null;
  onCreateTask: (data: {
    title: string;
    description?: string;
    columnId?: number | null;
    priority?: string;
    dueDate?: string;
    tags?: string;
    assigneeIds?: number[];
  }) => Promise<void>;
  onUpdateTask: (taskId: number, data: Partial<WorkboardTask> & { assigneeIds?: number[] }) => Promise<void>;
  onDeleteTask: (taskId: number) => Promise<void>;
  onBulkDelete: (taskIds: number[]) => Promise<void>;
}

export default function TableView({
  columns,
  tasks,
  members,
  canEdit,
  myRole = null,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onBulkDelete,
}: TableViewProps) {
  const { data: me } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const myUserId = me?.user?.id ?? null;
  const [search, setSearch] = useState("");
  const [boardFilter, setBoardFilter] = useState<BoardFilterState>(EMPTY_FILTER);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const [taskModal, setTaskModal] = useState<{ open: boolean; task?: WorkboardTask | null }>({ open: false });
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const colMap = Object.fromEntries(columns.map((c) => [c.id, c.name]));

  const filtered = useMemo(() => {
    // Assignee/tag filter first (§7), then search, then sort.
    let result = tasks.filter((t) => matchesFilter(t, boardFilter));
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((t) => t.title.toLowerCase().includes(q));
    }
    if (sortKey) {
      result = [...result].sort((a, b) => {
        let av: string | number = "";
        let bv: string | number = "";
        if (sortKey === "priority") {
          av = PRIORITY_ORDER[a.priority as keyof typeof PRIORITY_ORDER] ?? 1;
          bv = PRIORITY_ORDER[b.priority as keyof typeof PRIORITY_ORDER] ?? 1;
        } else if (sortKey === "dueDate") {
          av = a.dueDate ?? "9999";
          bv = b.dueDate ?? "9999";
        } else if (sortKey === "columnId") {
          av = colMap[a.columnId!] ?? "";
          bv = colMap[b.columnId!] ?? "";
        } else {
          av = a.title.toLowerCase();
          bv = b.title.toLowerCase();
        }
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
    }
    return result;
  }, [tasks, boardFilter, search, sortKey, sortDir, colMap]);

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortKey(null); }
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === paginated.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(paginated.map((t) => t.id)));
    }
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    try {
      await onBulkDelete([...selected]);
      setSelected(new Set());
    } finally {
      setBulkDeleting(false);
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc" ? (
      <ChevronUp className="w-3 h-3 ml-1" />
    ) : (
      <ChevronDown className="w-3 h-3 ml-1" />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Cari task..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        />
        <BoardFilterBar
          tasks={tasks}
          members={members}
          currentUserId={myUserId}
          value={boardFilter}
          onChange={(next) => { setBoardFilter(next); setPage(0); }}
        />
        {selected.size > 0 && canEdit && (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
          >
            <Trash2 className="w-4 h-4 mr-1" />
            Hapus {selected.size} Task
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {canEdit && (
                <th className="w-10 px-3 py-2 text-left">
                  <Checkbox
                    checked={selected.size === paginated.length && paginated.length > 0}
                    onCheckedChange={toggleAll}
                  />
                </th>
              )}
              <th
                className="px-3 py-2 text-left font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                onClick={() => toggleSort("title")}
              >
                <span className="flex items-center">Judul <SortIcon k="title" /></span>
              </th>
              <th
                className="px-3 py-2 text-left font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                onClick={() => toggleSort("columnId")}
              >
                <span className="flex items-center">Status <SortIcon k="columnId" /></span>
              </th>
              <th
                className="px-3 py-2 text-left font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                onClick={() => toggleSort("priority")}
              >
                <span className="flex items-center">Prioritas <SortIcon k="priority" /></span>
              </th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Assignee</th>
              <th
                className="px-3 py-2 text-left font-medium cursor-pointer hover:text-foreground whitespace-nowrap"
                onClick={() => toggleSort("dueDate")}
              >
                <span className="flex items-center">Tenggat <SortIcon k="dueDate" /></span>
              </th>
              <th className="px-3 py-2 text-left font-medium">Tags</th>
              {canEdit && <th className="w-10 px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginated.map((task) => {
              const isOverdue = task.dueDate && !task.isCompleted && isPast(parseISO(task.dueDate));
              const tags = task.tags ? task.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
              return (
                <tr
                  key={task.id}
                  className="hover:bg-muted/30 cursor-pointer"
                  onClick={() => setTaskModal({ open: true, task })}
                >
                  {canEdit && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(task.id)}
                        onCheckedChange={() => toggleSelect(task.id)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium max-w-48 truncate">
                    <span className={task.isCompleted ? "line-through text-muted-foreground" : ""}>
                      {task.title}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {task.columnId ? (colMap[task.columnId] ?? "—") : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        PRIORITY_STYLES[task.priority] ?? ""
                      }`}
                    >
                      {PRIORITY_LABELS[task.priority] ?? task.priority}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex -space-x-1">
                      {task.assignees.slice(0, 3).map((a) => (
                        <div
                          key={a.userId}
                          className="w-5 h-5 rounded-full bg-primary/20 border border-background flex items-center justify-center text-[9px] font-bold"
                          title={a.name ?? a.email ?? ""}
                        >
                          {(a.name ?? a.email ?? "?").slice(0, 1).toUpperCase()}
                        </div>
                      ))}
                      {task.assignees.length > 3 && (
                        <div className="w-5 h-5 rounded-full bg-muted border border-background flex items-center justify-center text-[9px]">
                          +{task.assignees.length - 3}
                        </div>
                      )}
                    </div>
                  </td>
                  <td
                    className={`px-3 py-2 text-xs whitespace-nowrap ${
                      isOverdue ? "text-red-500 font-medium" : "text-muted-foreground"
                    }`}
                  >
                    {task.dueDate ? format(parseISO(task.dueDate), "d MMM yyyy") : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 flex-wrap max-w-32">
                      {tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] px-1 py-0">
                          {tag}
                        </Badge>
                      ))}
                      {tags.length > 2 && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          +{tags.length - 2}
                        </Badge>
                      )}
                    </div>
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => onDeleteTask(task.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            {paginated.length === 0 && (
              <tr>
                <td
                  colSpan={canEdit ? 8 : 7}
                  className="px-3 py-8 text-center text-muted-foreground text-sm"
                >
                  Tidak ada task ditemukan
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} dari{" "}
            {filtered.length} task
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Sebelumnya
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Berikutnya
            </Button>
          </div>
        </div>
      )}

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
