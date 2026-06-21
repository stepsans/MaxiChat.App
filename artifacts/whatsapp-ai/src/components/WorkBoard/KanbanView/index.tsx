import { useState, useEffect, useRef } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import type { WorkboardColumn, WorkboardTask, WorkboardMember } from "@/hooks/useBoardDetail";
import KanbanColumn from "./KanbanColumn";
import TaskModal from "../TaskModal";
import BoardFilterBar, { EMPTY_FILTER, type BoardFilterState } from "../BoardFilterBar";
import { matchesFilter } from "../board-filter";
import { useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

interface KanbanViewPropsSimple {
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  canEdit: boolean;
  myRole?: "owner" | "editor" | "viewer" | null;
  onMoveTask: (taskId: number, columnId: number | null, position: number) => Promise<void>;
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
  onCreateColumn: (data: { name: string; color?: string }) => Promise<void>;
}

export default function KanbanView({
  columns,
  tasks,
  members,
  canEdit,
  myRole = null,
  onMoveTask,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onCreateColumn,
}: KanbanViewPropsSimple) {
  const { data: me } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const myUserId = me?.user?.id ?? null;
  const [filter, setFilter] = useState<BoardFilterState>(EMPTY_FILTER);
  const [taskModal, setTaskModal] = useState<{
    open: boolean;
    task?: WorkboardTask | null;
    preColumnId?: number;
  }>({ open: false });
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  // localTasks used only during optimistic drag-and-drop; reset after server confirms
  const [localTasks, setLocalTasks] = useState<WorkboardTask[] | null>(null);
  const latestTasksRef = useRef(tasks);
  latestTasksRef.current = tasks;

  // Reset localTasks when server data refreshes (after a successful move)
  useEffect(() => {
    setLocalTasks(null);
  }, [tasks]);

  const displayTasks = (localTasks ?? tasks).filter((t) => matchesFilter(t, filter));

  function tasksForColumn(colId: number) {
    return displayTasks
      .filter((t) => t.columnId === colId)
      .sort((a, b) => a.position - b.position);
  }

  async function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const taskId = Number(draggableId);
    const newColumnId = Number(destination.droppableId);

    // Optimistic update immediately
    const base = latestTasksRef.current;
    const updated = base.map((t) =>
      t.id === taskId ? { ...t, columnId: newColumnId, position: destination.index } : t
    );
    setLocalTasks(updated);

    try {
      await onMoveTask(taskId, newColumnId, destination.index);
      // server refetch will trigger the useEffect above to reset localTasks
    } catch {
      setLocalTasks(null);
    }
  }

  async function handleAddColumn() {
    if (!newColumnName.trim()) return;
    try {
      await onCreateColumn({ name: newColumnName.trim() });
      setNewColumnName("");
      setAddColumnOpen(false);
    } catch {
      // error shown via toast
    }
  }

  // Capture taskModal in a ref so onSave closure always has the latest value
  const taskModalRef = useRef(taskModal);
  taskModalRef.current = taskModal;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex-shrink-0">
        <BoardFilterBar
          tasks={tasks}
          members={members}
          currentUserId={myUserId}
          value={filter}
          onChange={setFilter}
        />
      </div>
      <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
      <DragDropContext onDragEnd={handleDragEnd}>
        {columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            tasks={tasksForColumn(col.id)}
            canEdit={canEdit}
            onCardClick={(task) => setTaskModal({ open: true, task })}
            onAddTask={(columnId) => setTaskModal({ open: true, task: null, preColumnId: columnId })}
          />
        ))}
      </DragDropContext>

      {canEdit && (
        <div className="w-72 flex-shrink-0">
          {addColumnOpen ? (
            <div className="bg-muted/40 rounded-xl border p-3 space-y-2">
              <Input
                autoFocus
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddColumn();
                  if (e.key === "Escape") setAddColumnOpen(false);
                }}
                placeholder="Nama kolom baru"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddColumn} disabled={!newColumnName.trim()}>
                  Tambah
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setAddColumnOpen(false); setNewColumnName(""); }}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="w-full h-10 border-dashed"
              onClick={() => setAddColumnOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              Tambah Kolom
            </Button>
          )}
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
        // Pass the preColumnId so TaskModal pre-selects the correct column
        preColumnId={taskModal.preColumnId}
        onSave={async (data) => {
          const modal = taskModalRef.current;
          if (modal.task) {
            await onUpdateTask(modal.task.id, data);
          } else {
            await onCreateTask({
              ...data,
              // If user explicitly changed the column in modal, use that; else use the clicked column
              columnId: data.columnId !== undefined ? data.columnId : (modal.preColumnId ?? null),
            });
          }
        }}
        onDelete={taskModal.task ? () => onDeleteTask(taskModal.task!.id) : undefined}
      />
      </div>
    </div>
  );
}
