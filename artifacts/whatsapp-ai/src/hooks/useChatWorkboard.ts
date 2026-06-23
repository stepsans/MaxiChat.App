import { useQuery, useMutation } from "@tanstack/react-query";

export interface ChatWorkboardTask {
  id: number;
  boardId: number;
  title: string;
  priority: string;
  isCompleted: boolean;
  createdAt: string;
  boardName: string;
  boardColor: string;
  boardEmoji: string | null;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Riwayat task yang dibuat dari sebuah chat (source_chat_id = chatId), dibatasi
// ke board yang user-nya member. Raw apiFetch — modul workboard di luar Orval.
export function useChatWorkboardTasks(chatId: number) {
  const queryKey = ["/api/workboard/chats", chatId, "tasks"];
  const { data, isLoading } = useQuery<{ tasks: ChatWorkboardTask[] }>({
    queryKey,
    queryFn: () => apiFetch(`/api/workboard/chats/${chatId}/tasks`),
    enabled: !!chatId,
  });
  return { tasks: data?.tasks ?? [], loading: isLoading, queryKey };
}

// Rangkum percakapan chat → deskripsi task (AI). Mengembalikan {summary}.
// Melempar Error dengan .status (402 = kredit habis, 503 = engine down).
export function useSummarizeChatForTask(chatId: number) {
  return useMutation<{ summary: string }, Error & { status?: number }>({
    mutationFn: () =>
      apiFetch(`/api/chats/${chatId}/summarize-for-task`, { method: "POST" }),
  });
}
