import { useEffect } from "react";
import { useLocation } from "wouter";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkboard } from "@/hooks/useWorkboard";
import BoardCard from "@/components/WorkBoard/BoardCard";
import CreateBoardModal from "@/components/WorkBoard/CreateBoardModal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { Plus, LayoutDashboard } from "lucide-react";

export default function WorkBoardPage() {
  const [, navigate] = useLocation();
  const { menus, isLoading: permLoading } = usePermissions();
  const { boards, loading, createBoard, isCreating } = useWorkboard();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!permLoading && !menus.workboard?.canView) {
      navigate("/");
    }
  }, [permLoading, menus.workboard?.canView, navigate]);

  if (permLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!menus.workboard?.canView) return null;

  return (
    <div className="flex flex-col h-full p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">WorkBoard</h1>
          <p className="text-sm text-muted-foreground">Kelola pekerjaan tim Anda</p>
        </div>
        {menus.workboard?.canCreate && (
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Buat Board
          </Button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : boards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <LayoutDashboard className="w-8 h-8 text-primary/60" />
          </div>
          <div>
            <p className="font-semibold text-lg">Belum ada board</p>
            <p className="text-sm text-muted-foreground mt-1">
              Buat board pertama Anda untuk mulai mengorganisir pekerjaan tim
            </p>
          </div>
          {menus.workboard?.canCreate && (
            <Button onClick={() => setCreateOpen(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Buat Board Pertama
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {boards.map((board) => (
            <BoardCard key={board.id} board={board} />
          ))}
        </div>
      )}

      <CreateBoardModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={createBoard}
      />
    </div>
  );
}
