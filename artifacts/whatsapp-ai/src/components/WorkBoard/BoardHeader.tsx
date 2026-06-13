import { Button } from "@/components/ui/button";
import { LayoutDashboard, Table2, CheckSquare, UserPlus, Users, Eye } from "lucide-react";

type ViewType = "kanban" | "table" | "todo";

interface BoardHeaderProps {
  boardName: string;
  boardEmoji?: string | null;
  boardColor: string;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  myRole: string | null;
  memberCount: number;
  onInvite: () => void;
  onMemberList: () => void;
}

const VIEW_TABS: Array<{ key: ViewType; label: string; Icon: typeof LayoutDashboard }> = [
  { key: "kanban", label: "Kanban", Icon: LayoutDashboard },
  { key: "table", label: "Table", Icon: Table2 },
  { key: "todo", label: "Todo", Icon: CheckSquare },
];

export default function BoardHeader({
  boardName,
  boardEmoji,
  boardColor,
  activeView,
  onViewChange,
  myRole,
  memberCount,
  onInvite,
  onMemberList,
}: BoardHeaderProps) {
  const isOwner = myRole === "owner";
  const isViewer = myRole === "viewer";

  return (
    <div className="flex items-center gap-3 flex-wrap pb-3 border-b">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {boardEmoji ? (
          <span className="text-xl">{boardEmoji}</span>
        ) : (
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold"
            style={{ backgroundColor: boardColor }}
          />
        )}
        <h1 className="font-bold text-lg truncate">{boardName}</h1>
        {isViewer && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground border rounded px-1.5 py-0.5 flex-shrink-0">
            <Eye className="w-3 h-3" />
            View Only
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 border rounded-lg p-0.5">
        {VIEW_TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => onViewChange(key)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
              activeView === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onMemberList} className="gap-1.5">
          <Users className="w-3.5 h-3.5" />
          {memberCount}
        </Button>
        {isOwner && (
          <Button size="sm" onClick={onInvite} className="gap-1.5">
            <UserPlus className="w-3.5 h-3.5" />
            Invite
          </Button>
        )}
      </div>
    </div>
  );
}
