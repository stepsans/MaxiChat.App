import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export interface WorkboardBoard {
  id: number;
  ownerUserId: number;
  createdByUserId: number;
  name: string;
  description: string | null;
  defaultView: string;
  color: string;
  emoji: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
  taskCount?: number;
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

export function useWorkboard(archived = false) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["/api/workboard/boards", archived];

  const { data, isLoading } = useQuery<{ boards: WorkboardBoard[] }>({
    queryKey,
    queryFn: () => apiFetch(`/api/workboard/boards?archived=${archived}`),
  });

  const createBoardMut = useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      defaultView?: string;
      color?: string;
      emoji?: string;
    }) =>
      apiFetch<{ board: WorkboardBoard }>("/api/workboard/boards", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/workboard/boards"] });
      toast({ description: "Board berhasil dibuat." });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", description: err.message });
    },
  });

  const updateBoardMut = useMutation({
    mutationFn: ({
      boardId,
      data: body,
    }: {
      boardId: number;
      data: Partial<Pick<WorkboardBoard, "name" | "description" | "defaultView" | "color" | "emoji" | "isArchived">>;
    }) =>
      apiFetch<{ board: WorkboardBoard }>(`/api/workboard/boards/${boardId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/workboard/boards"] });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", description: err.message });
    },
  });

  const deleteBoardMut = useMutation({
    mutationFn: (boardId: number) =>
      apiFetch(`/api/workboard/boards/${boardId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/workboard/boards"] });
      toast({ description: "Board dihapus." });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", description: err.message });
    },
  });

  return {
    boards: data?.boards ?? [],
    loading: isLoading,
    createBoard: async (body: Parameters<typeof createBoardMut.mutateAsync>[0]): Promise<void> => {
      await createBoardMut.mutateAsync(body);
    },
    updateBoard: async (boardId: number, d: Parameters<typeof updateBoardMut.mutateAsync>[0]["data"]): Promise<void> => {
      await updateBoardMut.mutateAsync({ boardId, data: d });
    },
    deleteBoard: async (boardId: number): Promise<void> => {
      await deleteBoardMut.mutateAsync(boardId);
    },
    archiveBoard: async (boardId: number): Promise<void> => {
      await updateBoardMut.mutateAsync({ boardId, data: { isArchived: true } });
    },
    isCreating: createBoardMut.isPending,
  };
}
