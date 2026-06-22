import { Draggable } from "@hello-pangea/dnd";
import type { WorkboardTask } from "@/hooks/useBoardDetail";
import { Badge } from "@/components/ui/badge";
import { Calendar, AlertCircle } from "lucide-react";
import { format, isPast, parseISO } from "date-fns";
import AssigneeAvatar from "../AssigneeAvatar";

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low: "bg-slate-100 text-slate-600 border-slate-200",
};
const PRIORITY_LABELS: Record<string, string> = {
  high: "Tinggi",
  medium: "Sedang",
  low: "Rendah",
};

interface KanbanCardProps {
  task: WorkboardTask;
  index: number;
  onClick: () => void;
}

export default function KanbanCard({ task, index, onClick }: KanbanCardProps) {
  const isOverdue = task.dueDate && !task.isCompleted && isPast(parseISO(task.dueDate));
  const tags = task.tags ? task.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const visibleTags = tags.slice(0, 2);
  const extraTags = tags.length - 2;
  const visibleAssignees = task.assignees.slice(0, 3);
  const extraAssignees = task.assignees.length - 3;

  return (
    <Draggable draggableId={String(task.id)} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={onClick}
          className={`bg-card border rounded-lg p-3 cursor-pointer hover:shadow-sm transition-all space-y-2 ${
            snapshot.isDragging ? "shadow-lg rotate-1 border-primary/50" : ""
          }`}
        >
          <p
            className={`text-sm font-medium leading-snug ${
              task.isCompleted ? "line-through text-muted-foreground" : ""
            }`}
          >
            {task.title}
          </p>

          <div className="flex items-center gap-1 flex-wrap">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${
                PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.medium
              }`}
            >
              {PRIORITY_LABELS[task.priority] ?? task.priority}
            </span>

            {visibleTags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                {tag}
              </Badge>
            ))}
            {extraTags > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                +{extraTags}
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between">
            {task.dueDate && (
              <span
                className={`flex items-center gap-1 text-[10px] ${
                  isOverdue ? "text-red-500" : "text-muted-foreground"
                }`}
              >
                {isOverdue ? <AlertCircle className="w-3 h-3" /> : <Calendar className="w-3 h-3" />}
                {format(parseISO(task.dueDate), "d MMM")}
              </span>
            )}

            {task.assignees.length > 0 && (
              <div className="flex -space-x-1 ml-auto">
                {visibleAssignees.map((a) => (
                  <AssigneeAvatar
                    key={a.userId}
                    url={a.profilePhotoUrl}
                    name={a.name}
                    email={a.email}
                  />
                ))}
                {extraAssignees > 0 && (
                  <div className="w-5 h-5 rounded-full bg-muted border border-card flex items-center justify-center text-[9px] font-bold">
                    +{extraAssignees}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Draggable>
  );
}
