import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { usePermissions } from "@/hooks/use-permissions";
import { useBoardDetail } from "@/hooks/useBoardDetail";
import BoardHeader from "@/components/WorkBoard/BoardHeader";
import KanbanView from "@/components/WorkBoard/KanbanView";
import TableView from "@/components/WorkBoard/TableView";
import TodoView from "@/components/WorkBoard/TodoView";
import InviteMemberModal from "@/components/WorkBoard/InviteMemberModal";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type ViewType = "kanban" | "table" | "todo";

export default function BoardDetailPage() {
  const params = useParams<{ boardId: string }>();
  const boardId = Number(params.boardId);
  const [, navigate] = useLocation();
  const { menus, isLoading: permLoading } = usePermissions();
  const detail = useBoardDetail(boardId);

  const [activeView, setActiveView] = useState<ViewType>("kanban");
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    if (!permLoading && !menus.workboard?.canView) {
      navigate("/");
    }
  }, [permLoading, menus.workboard?.canView, navigate]);

  useEffect(() => {
    if (detail.board) {
      const v = detail.board.defaultView as ViewType;
      if (["kanban", "table", "todo"].includes(v)) setActiveView(v);
    }
  }, [detail.board?.id]);

  if (permLoading || detail.loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-60" />
        <div className="flex gap-3 overflow-x-auto">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="w-72 h-96 rounded-xl flex-shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  if (!detail.board) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Board tidak ditemukan.</p>
        <Button variant="link" onClick={() => navigate("/workboard")}>
          ← Kembali ke daftar board
        </Button>
      </div>
    );
  }

  const canEdit =
    detail.myRole === "owner" || detail.myRole === "editor";

  async function handleBulkDelete(taskIds: number[]) {
    await Promise.all(taskIds.map((id) => detail.deleteTask(id)));
  }

  return (
    <div className="flex flex-col h-full p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/workboard")}
          className="gap-1 text-muted-foreground"
        >
          <ChevronLeft className="w-4 h-4" />
          Boards
        </Button>
      </div>

      <BoardHeader
        boardName={detail.board.name}
        boardEmoji={detail.board.emoji}
        boardColor={detail.board.color}
        activeView={activeView}
        onViewChange={setActiveView}
        myRole={detail.myRole}
        memberCount={detail.members.length}
        onInvite={() => setInviteOpen(true)}
        onMemberList={() => setMemberModalOpen(true)}
      />

      <div className="flex-1 overflow-auto">
        {activeView === "kanban" && (
          <KanbanView
            columns={detail.columns}
            tasks={detail.tasks}
            members={detail.members}
            canEdit={canEdit}
            onMoveTask={detail.moveTask}
            onCreateTask={detail.createTask}
            onUpdateTask={detail.updateTask}
            onDeleteTask={detail.deleteTask}
            onCreateColumn={detail.createColumn}
          />
        )}

        {activeView === "table" && (
          <TableView
            columns={detail.columns}
            tasks={detail.tasks}
            members={detail.members}
            canEdit={canEdit}
            onCreateTask={detail.createTask}
            onUpdateTask={detail.updateTask}
            onDeleteTask={detail.deleteTask}
            onBulkDelete={handleBulkDelete}
          />
        )}

        {activeView === "todo" && (
          <TodoView
            columns={detail.columns}
            tasks={detail.tasks}
            members={detail.members}
            canEdit={canEdit}
            onCreateTask={detail.createTask}
            onUpdateTask={detail.updateTask}
            onDeleteTask={detail.deleteTask}
            onToggleComplete={detail.toggleComplete}
          />
        )}
      </div>

      <InviteMemberModal
        open={inviteOpen || memberModalOpen}
        onClose={() => { setInviteOpen(false); setMemberModalOpen(false); }}
        boardId={boardId}
        members={detail.members}
        myRole={detail.myRole ?? "viewer"}
        onInvite={(userId, role) => detail.inviteMember({ userId, role })}
        onUpdateRole={detail.updateMemberRole}
        onRemove={detail.removeMember}
      />
    </div>
  );
}
