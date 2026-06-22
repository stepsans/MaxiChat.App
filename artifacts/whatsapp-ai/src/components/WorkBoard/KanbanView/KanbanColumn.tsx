import { Droppable } from "@hello-pangea/dnd";
import type { WorkboardColumn, WorkboardTask } from "@/hooks/useBoardDetail";
import { Button } from "@/components/ui/button";
import { Plus, CheckCircle2 } from "lucide-react";
import KanbanCard from "./KanbanCard";

interface KanbanColumnProps {
  column: WorkboardColumn;
  tasks: WorkboardTask[];
  canEdit: boolean;
  isOwner: boolean;
  onCardClick: (task: WorkboardTask) => void;
  onAddTask: (columnId: number) => void;
  onToggleFinish: (columnId: number, isFinishStage: boolean) => void;
}

export default function KanbanColumn({
  column,
  tasks,
  canEdit,
  isOwner,
  onCardClick,
  onAddTask,
  onToggleFinish,
}: KanbanColumnProps) {
  return (
    <div className="flex flex-col w-72 flex-shrink-0 bg-muted/40 rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b">
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: column.color }}
        />
        <span className="font-semibold text-sm flex-1 truncate">{column.name}</span>
        {/* Finish-stage indicator + owner toggle. Tasks in a finish stage are
            "done" (Model A). Owners click to mark/unmark; others see it static. */}
        {isOwner ? (
          <button
            type="button"
            onClick={() => onToggleFinish(column.id, !column.isFinishStage)}
            title={
              column.isFinishStage
                ? "Hapus tanda stage selesai"
                : "Tandai sebagai stage selesai"
            }
            className="flex-shrink-0"
          >
            <CheckCircle2
              className={`w-4 h-4 transition-colors ${
                column.isFinishStage
                  ? "text-green-600"
                  : "text-muted-foreground/30 hover:text-muted-foreground"
              }`}
            />
          </button>
        ) : (
          column.isFinishStage && (
            <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" aria-label="Stage selesai" />
          )
        )}
        <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-medium">
          {tasks.length}
        </span>
      </div>

      <Droppable droppableId={String(column.id)}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 p-2 space-y-2 min-h-24 transition-colors ${
              snapshot.isDraggingOver ? "bg-primary/5" : ""
            }`}
          >
            {tasks.map((task, idx) => (
              <KanbanCard
                key={task.id}
                task={task}
                index={idx}
                onClick={() => onCardClick(task)}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>

      {canEdit && (
        <div className="p-2 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground hover:text-foreground justify-start gap-1"
            onClick={() => onAddTask(column.id)}
          >
            <Plus className="w-4 h-4" />
            Tambah Task
          </Button>
        </div>
      )}
    </div>
  );
}
