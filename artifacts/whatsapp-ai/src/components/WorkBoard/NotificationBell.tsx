import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Bell } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useWorkboardNotifications } from "@/hooks/useWorkboardNotifications";

// Bell surface for WorkBoard @mention notifications. Clicking a row marks it read
// and deep-links to the board (spec §4 target: /workboard/:boardId).
export default function NotificationBell() {
  const [, navigate] = useLocation();
  const { notifications, unreadCount, markRead, markAllRead } = useWorkboardNotifications();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative" aria-label="Notifikasi">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifikasi</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => markAllRead()}
              className="text-xs text-primary hover:underline"
            >
              Tandai semua dibaca
            </button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Belum ada notifikasi.
            </p>
          ) : (
            notifications.map((n) => {
              const actor = n.actorName ?? n.actorEmail ?? "Seseorang";
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.isRead) markRead(n.id);
                    navigate(`/workboard/${n.boardId}`);
                  }}
                  className={`flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent ${
                    n.isRead ? "" : "bg-primary/5"
                  }`}
                >
                  <span className="text-sm">
                    <span className="font-medium">{actor}</span> menyebut Anda di{" "}
                    <span className="font-medium">{n.taskTitle ?? "sebuah task"}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {n.boardName ? `${n.boardName} · ` : ""}
                    {formatDistanceToNow(new Date(n.createdAt), {
                      addSuffix: true,
                      locale: idLocale,
                    })}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
