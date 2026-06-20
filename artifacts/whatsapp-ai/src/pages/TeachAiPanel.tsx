import { useState, useRef, useEffect } from "react";
import {
  useGetAiMemoryChat,
  getGetAiMemoryChatQueryKey,
  useSendAiMemoryChat,
  useListAiMemories,
  getListAiMemoriesQueryKey,
  useDeleteAiMemory,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Send, Brain, Trash2, Sparkles } from "lucide-react";

// The "Ajari AI" category: a two-way chat where the tenant teaches the AI. What
// the AI decides to remember is shown in the side list and fed to the AI
// Pipeline analysis (per tenant).
export function TeachAiPanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: chat, isLoading } = useGetAiMemoryChat({
    query: { queryKey: getGetAiMemoryChatQueryKey() },
  });
  const { data: memData } = useListAiMemories({
    query: { queryKey: getListAiMemoriesQueryKey() },
  });

  const send = useSendAiMemoryChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAiMemoryChatQueryKey() });
        qc.invalidateQueries({ queryKey: getListAiMemoriesQueryKey() });
      },
    },
  });
  const del = useDeleteAiMemory({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListAiMemoriesQueryKey() }),
    },
  });

  const messages = chat?.messages ?? [];
  const memories = memData?.items ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, send.isPending]);

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft("");
    send.mutate({ data: { message: text } });
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full">
      {/* Chat column */}
      <div className="flex flex-col flex-1 min-h-0 border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-muted/30">
          <p className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> Ajari AI
          </p>
          <p className="text-xs text-muted-foreground">
            Beri tahu AI cara menilai lead & menangani percakapan bisnismu. Yang
            penting akan diingat dan dipakai di seluruh analisa pipeline.
          </p>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {isLoading ? (
            <>
              <Skeleton className="h-12 w-2/3" />
              <Skeleton className="h-12 w-1/2 ml-auto" />
            </>
          ) : messages.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-10">
              <Brain className="w-10 h-10 mx-auto mb-3 opacity-40" />
              Mulai ajari AI. Contoh: "Kalau kontak cuma tanya lowongan kerja,
              anggap bukan lead." atau "Pelanggan yang sebut budget di atas 10 juta
              prioritaskan."
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted"
                )}
              >
                {m.content}
              </div>
            ))
          )}
          {send.isPending && (
            <div className="bg-muted max-w-[80%] rounded-lg px-3 py-2 text-sm text-muted-foreground">
              AI sedang mengetik…
            </div>
          )}
        </div>

        <div className="border-t p-3 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ajari AI sesuatu…"
            disabled={send.isPending}
            data-testid="teach-ai-input"
          />
          <Button onClick={submit} disabled={send.isPending || !draft.trim()} className="gap-1">
            <Send className="w-4 h-4" /> Kirim
          </Button>
        </div>
      </div>

      {/* Memory column */}
      <div className="lg:w-72 shrink-0 border rounded-lg flex flex-col min-h-0">
        <div className="px-4 py-2.5 border-b bg-muted/30">
          <p className="text-sm font-medium flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" /> Yang diingat AI
          </p>
          <p className="text-xs text-muted-foreground">Khusus untuk tenant ini</p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {memories.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Belum ada yang diingat.
            </p>
          ) : (
            memories.map((mem) => (
              <div
                key={mem.id}
                className="group flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs"
                data-testid={`ai-memory-${mem.id}`}
              >
                <span className="flex-1">{mem.content}</span>
                <button
                  onClick={() => del.mutate({ id: mem.id })}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                  title="Lupakan"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
