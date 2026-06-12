import { useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import type { WorkboardColumn, WorkboardTask, WorkboardMember } from "@/hooks/useBoardDetail";
import KanbanColumn from "./KanbanColumn";
import TaskModal from "../TaskModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";

interface KanbanViewPropsSimple {
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  canEdit: boolean;
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
  onMoveTask,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onCreateColumn,
}: KanbanViewPropsSimple) {
  const [taskModal, setTaskModal] = useState<{
    open: boolean;
    task?: WorkboardTask | null;
    preColumnId?: number;
  }>({ open: false });
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [localTasks, setLocalTasks] = useState<WorkboardTask[] | null>(null);

  const displayTasks = localTasks ?? tasks;

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

    // Optimistic update
    const updated = (localTasks ?? tasks).map((t) =>
      t.id === taskId ? { ...t, columnId: newColumnId, position: destination.index } : t
    );
    setLocalTasks(updated);

    try {
      await onMoveTask(taskId, newColumnId, destination.index);
    } catch {
      setLocalTasks(null);
    }
  }

  async function handleAddColumn() {
    if (!newColumnName.trim()) return;
    await onCreateColumn({ name: newColumnName.trim() });
    setNewColumnName("");
    setAddColumnOpen(false);
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 h-full">
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
        onSave={async (data) => {
          if (taskModal.task) {
            await onUpdateTask(taskModal.task.id, data);
          } else {
            await onCreateTask({
              ...data,
              columnId: data.columnId ?? taskModal.preColumnId ?? null,
            });
          }
        }}
        onDelete={taskModal.task ? () => onDeleteTask(taskModal.task!.id) : undefined}
      />
    </div>
  );
}
