import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { WorkboardBoard } from "./useWorkboard";

export interface WorkboardColumn {
  id: number;
  boardId: number;
  name: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkboardAssignee {
  userId: number;
  name: string | null;
  email: string | null;
}

export interface WorkboardTask {
  id: number;
  boardId: number;
  columnId: number | null;
  title: string;
  description: string | null;
  priority: string;
  position: number;
  dueDate: string | null;
  tags: string | null;
  isCompleted: boolean;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
  assignees: WorkboardAssignee[];
}

export interface WorkboardMember {
  id: number;
  boardId: number;
  userId: number;
  role: string;
  invitedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  name: string | null;
  email: string | null;
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

export function useBoardDetail(boardId: number) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const boardKey = ["/api/workboard/boards", boardId];
  const tasksKey = ["/api/workboard/boards", boardId, "tasks"];

  const { data: boardData, isLoading: boardLoading } = useQuery<{
    board: WorkboardBoard;
    columns: WorkboardColumn[];
    tasks: WorkboardTask[];
    members: WorkboardMember[];
    myRole: string;
  }>({
    queryKey: boardKey,
    queryFn: () => apiFetch(`/api/workboard/boards/${boardId}`),
    enabled: !!boardId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: boardKey });
    qc.invalidateQueries({ queryKey: tasksKey });
    qc.invalidateQueries({ queryKey: ["/api/workboard/boards"] });
  };

  // ── Tasks ────────────────────────────────────────────────────────────────
  const createTaskMut = useMutation({
    mutationFn: (body: {
      title: string;
      description?: string;
      columnId?: number | null;
      priority?: string;
      dueDate?: string;
      tags?: string;
      assigneeIds?: number[];
    }) =>
      apiFetch<{ task: WorkboardTask }>(`/api/workboard/boards/${boardId}/tasks`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => { invalidate(); toast({ description: "Task dibuat." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const updateTaskMut = useMutation({
    mutationFn: ({ taskId, data }: { taskId: number; data: Partial<WorkboardTask> & { assigneeIds?: number[] } }) =>
      apiFetch<{ task: WorkboardTask }>(`/api/workboard/boards/${boardId}/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const deleteTaskMut = useMutation({
    mutationFn: (taskId: number) =>
      apiFetch(`/api/workboard/boards/${boardId}/tasks/${taskId}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ description: "Task dihapus." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const moveTaskMut = useMutation({
    mutationFn: ({ taskId, columnId, position }: { taskId: number; columnId: number | null; position: number }) =>
      apiFetch<{ task: WorkboardTask }>(`/api/workboard/boards/${boardId}/tasks/${taskId}/move`, {
        method: "PATCH",
        body: JSON.stringify({ columnId, position }),
      }),
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const toggleCompleteMut = useMutation({
    mutationFn: ({ taskId, isCompleted }: { taskId: number; isCompleted: boolean }) =>
      apiFetch<{ task: WorkboardTask }>(`/api/workboard/boards/${boardId}/tasks/${taskId}/complete`, {
        method: "PATCH",
        body: JSON.stringify({ isCompleted }),
      }),
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  // ── Columns ──────────────────────────────────────────────────────────────
  const createColumnMut = useMutation({
    mutationFn: (body: { name: string; color?: string }) =>
      apiFetch<{ column: WorkboardColumn }>(`/api/workboard/boards/${boardId}/columns`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => { invalidate(); toast({ description: "Kolom dibuat." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const updateColumnMut = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: Partial<Pick<WorkboardColumn, "name" | "color" | "position">> }) =>
      apiFetch<{ column: WorkboardColumn }>(`/api/workboard/boards/${boardId}/columns/${columnId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const deleteColumnMut = useMutation({
    mutationFn: (columnId: number) =>
      apiFetch(`/api/workboard/boards/${boardId}/columns/${columnId}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ description: "Kolom dihapus." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  // ── Members ───────────────────────────────────────────────────────────────
  const inviteMemberMut = useMutation({
    mutationFn: (body: { userId: number; role: string }) =>
      apiFetch(`/api/workboard/boards/${boardId}/members`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => { invalidate(); toast({ description: "Member diundang." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const updateMemberRoleMut = useMutation({
    mutationFn: ({ memberId, role }: { memberId: number; role: string }) =>
      apiFetch(`/api/workboard/boards/${boardId}/members/${memberId}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  const removeMemberMut = useMutation({
    mutationFn: (memberId: number) =>
      apiFetch(`/api/workboard/boards/${boardId}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => { invalidate(); toast({ description: "Member dihapus dari board." }); },
    onError: (err: Error) => { toast({ variant: "destructive", description: err.message }); },
  });

  return {
    board: boardData?.board ?? null,
    columns: boardData?.columns ?? [],
    tasks: boardData?.tasks ?? [],
    members: boardData?.members ?? [],
    myRole: (boardData?.myRole ?? null) as "owner" | "editor" | "viewer" | null,
    loading: boardLoading,
    createTask: async (data: Parameters<typeof createTaskMut.mutateAsync>[0]): Promise<void> => {
      await createTaskMut.mutateAsync(data);
    },
    updateTask: async (taskId: number, data: Parameters<typeof updateTaskMut.mutateAsync>[0]["data"]): Promise<void> => {
      await updateTaskMut.mutateAsync({ taskId, data });
    },
    deleteTask: async (taskId: number): Promise<void> => {
      await deleteTaskMut.mutateAsync(taskId);
    },
    moveTask: async (taskId: number, columnId: number | null, position: number): Promise<void> => {
      await moveTaskMut.mutateAsync({ taskId, columnId, position });
    },
    toggleComplete: async (taskId: number, isCompleted: boolean): Promise<void> => {
      await toggleCompleteMut.mutateAsync({ taskId, isCompleted });
    },
    createColumn: async (data: Parameters<typeof createColumnMut.mutateAsync>[0]): Promise<void> => {
      await createColumnMut.mutateAsync(data);
    },
    updateColumn: async (columnId: number, data: Parameters<typeof updateColumnMut.mutateAsync>[0]["data"]): Promise<void> => {
      await updateColumnMut.mutateAsync({ columnId, data });
    },
    deleteColumn: async (columnId: number): Promise<void> => {
      await deleteColumnMut.mutateAsync(columnId);
    },
    inviteMember: async (data: Parameters<typeof inviteMemberMut.mutateAsync>[0]): Promise<void> => {
      await inviteMemberMut.mutateAsync(data);
    },
    updateMemberRole: async (memberId: number, role: string): Promise<void> => {
      await updateMemberRoleMut.mutateAsync({ memberId, role });
    },
    removeMember: async (memberId: number): Promise<void> => {
      await removeMemberMut.mutateAsync(memberId);
    },
  };
}
