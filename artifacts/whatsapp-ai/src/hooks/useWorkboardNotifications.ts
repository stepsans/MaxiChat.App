import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface WorkboardNotification {
  id: number;
  boardId: number;
  taskId: number;
  commentId: number;
  type: string;
  isRead: boolean;
  createdAt: string;
  actorUserId: number;
  actorName: string | null;
  actorEmail: string | null;
  taskTitle: string | null;
  boardName: string | null;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const KEY = ["/api/workboard/notifications"];

// WorkBoard @mention notifications for the signed-in user (powers the bell).
export function useWorkboardNotifications(enabled = true) {
  const qc = useQueryClient();

  const { data } = useQuery<{ notifications: WorkboardNotification[]; unreadCount: number }>({
    queryKey: KEY,
    queryFn: () => apiFetch(`/api/workboard/notifications`),
    enabled,
    refetchInterval: 60_000,
  });

  const markReadMut = useMutation({
    mutationFn: (notifId: number) =>
      apiFetch(`/api/workboard/notifications/${notifId}/read`, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const markAllReadMut = useMutation({
    mutationFn: () => apiFetch(`/api/workboard/notifications/read-all`, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  return {
    notifications: data?.notifications ?? [],
    unreadCount: data?.unreadCount ?? 0,
    markRead: (id: number) => markReadMut.mutate(id),
    markAllRead: () => markAllReadMut.mutate(),
  };
}
