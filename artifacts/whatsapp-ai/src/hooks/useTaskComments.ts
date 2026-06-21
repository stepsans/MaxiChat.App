import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export interface WorkboardComment {
  id: number;
  taskId: number;
  body: string;
  mentionedUserIds: number[];
  authorUserId: number;
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string;
}

export interface MentionCandidate {
  userId: number;
  name: string | null;
  email: string | null;
  role: string;
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

// Comments + @mention candidates for a single task. `enabled` lets callers hold
// off fetching until the task modal is actually open for an existing task
// (comments are meaningless for an unsaved task).
export function useTaskComments(boardId: number, taskId: number, enabled: boolean) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ready = enabled && Number.isInteger(boardId) && Number.isInteger(taskId) && taskId > 0;
  const commentsKey = ["/api/workboard/boards", boardId, "tasks", taskId, "comments"];
  const candidatesKey = ["/api/workboard/boards", boardId, "mention-candidates"];

  const { data: commentsData, isLoading: commentsLoading } = useQuery<{ comments: WorkboardComment[] }>({
    queryKey: commentsKey,
    queryFn: () =>
      apiFetch(`/api/workboard/boards/${boardId}/tasks/${taskId}/comments`),
    enabled: ready,
  });

  // Candidate list is per-board, so it can be cached across tasks of the same board.
  const { data: candidatesData } = useQuery<{ candidates: MentionCandidate[] }>({
    queryKey: candidatesKey,
    queryFn: () => apiFetch(`/api/workboard/boards/${boardId}/mention-candidates`),
    enabled: ready,
    staleTime: 60_000,
  });

  const createMut = useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ comment: WorkboardComment }>(
        `/api/workboard/boards/${boardId}/tasks/${taskId}/comments`,
        { method: "POST", body: JSON.stringify({ body }) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: commentsKey });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", description: err.message });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (commentId: number) =>
      apiFetch(
        `/api/workboard/boards/${boardId}/tasks/${taskId}/comments/${commentId}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: commentsKey });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", description: err.message });
    },
  });

  return {
    comments: commentsData?.comments ?? [],
    loading: commentsLoading,
    candidates: candidatesData?.candidates ?? [],
    sending: createMut.isPending,
    addComment: async (body: string): Promise<void> => {
      await createMut.mutateAsync(body);
    },
    deleteComment: async (commentId: number): Promise<void> => {
      await deleteMut.mutateAsync(commentId);
    },
  };
}
