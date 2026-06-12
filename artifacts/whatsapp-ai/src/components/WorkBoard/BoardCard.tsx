import type { ReactNode } from "react";
import { useLocation } from "wouter";
import type { WorkboardBoard } from "@/hooks/useWorkboard";
import { LayoutDashboard, Table2, CheckSquare, Users, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { id as idLocale } from "date-fns/locale";

const VIEW_ICONS: Record<string, ReactNode> = {
  kanban: <LayoutDashboard className="w-3 h-3" />,
  table: <Table2 className="w-3 h-3" />,
  todo: <CheckSquare className="w-3 h-3" />,
};
const VIEW_LABELS: Record<string, string> = {
  kanban: "Kanban",
  table: "Table",
  todo: "Todo",
};

interface BoardCardProps {
  board: WorkboardBoard;
}

export default function BoardCard({ board }: BoardCardProps) {
  const [, navigate] = useLocation();

  return (
    <div
      className="group relative bg-card border rounded-xl p-4 cursor-pointer hover:shadow-md hover:border-primary/30 transition-all"
      onClick={() => navigate(`/workboard/${board.id}`)}
    >
      <div
        className="absolute top-0 left-0 right-0 h-1 rounded-t-xl"
        style={{ backgroundColor: board.color }}
      />

      <div className="flex items-start gap-3 mt-1">
        {board.emoji ? (
          <span className="text-2xl leading-none mt-0.5">{board.emoji}</span>
        ) : (
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
            style={{ backgroundColor: board.color }}
          >
            {board.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm leading-tight truncate">{board.name}</h3>
          {board.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{board.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" />
          {board.memberCount ?? 0} member
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          {board.taskCount ?? 0} task
        </span>
        <span className="flex items-center gap-1 ml-auto border rounded px-1.5 py-0.5">
          {VIEW_ICONS[board.defaultView]}
          {VIEW_LABELS[board.defaultView]}
        </span>
      </div>

      <p className="text-[10px] text-muted-foreground/60 mt-2">
        Diperbarui{" "}
        {formatDistanceToNow(new Date(board.updatedAt), {
          addSuffix: true,
          locale: idLocale,
        })}
      </p>
    </div>
  );
}
