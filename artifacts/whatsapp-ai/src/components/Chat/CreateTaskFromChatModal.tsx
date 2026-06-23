import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkboard } from "@/hooks/useWorkboard";
import { useBoardDetail } from "@/hooks/useBoardDetail";
import { useSummarizeChatForTask } from "@/hooks/useChatWorkboard";
import { LayoutDashboard, MessageCircle, Sparkles, Loader2 } from "lucide-react";

interface CreateTaskFromChatModalProps {
  open: boolean;
  onClose: () => void;
  chatId: number;
  contactDisplayName: string; // chat.nickname || chat.contactName
  contactPhone: string; // chat.phoneNumber
  lastMessage: string | null; // chat.lastMessage
}

type Priority = "low" | "medium" | "high";
type AiState = "idle" | "loading" | "done" | "error" | "nocredit";

const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: "low", label: "Rendah", color: "#9ca3af" },
  { value: "medium", label: "Sedang", color: "#f59e0b" },
  { value: "high", label: "Tinggi", color: "#ef4444" },
];

// today + n days → "YYYY-MM-DD" in local time (matches <input type="date">).
function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateId(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function CreateTaskFromChatModal({
  open,
  onClose,
  chatId,
  contactDisplayName,
  contactPhone,
  lastMessage,
}: CreateTaskFromChatModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { boards } = useWorkboard();
  const summarize = useSummarizeChatForTask(chatId);

  const [boardId, setBoardId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [tags, setTags] = useState("");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [submitting, setSubmitting] = useState(false);

  const detail = useBoardDetail(boardId ?? 0);

  const defaultDescription = useMemo(() => {
    const head = `Dari chat WhatsApp: ${contactDisplayName} (${contactPhone})`;
    return lastMessage ? `${head}\nPesan terakhir: "${lastMessage}"` : head;
  }, [contactDisplayName, contactPhone, lastMessage]);

  // Reset the form each time the dialog opens (or the chat changes underneath).
  useEffect(() => {
    if (!open) return;
    setBoardId(null);
    setTitle(`Follow up: ${contactDisplayName}`);
    setDescription(defaultDescription);
    setPriority("medium");
    setDueDate(null);
    setTags("");
    setAiState("idle");
    setSubmitting(false);
  }, [open, contactDisplayName, defaultDescription]);

  async function handleGenerateAI() {
    setAiState("loading");
    try {
      const { summary } = await summarize.mutateAsync();
      setDescription(summary); // hasil AI MENGGANTI isi deskripsi, tetap bisa diedit
      setAiState("done");
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status === 402) {
        setAiState("nocredit");
        toast({
          variant: "destructive",
          description: "Kredit AI habis — isi ulang untuk pakai rangkuman otomatis.",
        });
      } else {
        setAiState("error");
        toast({
          variant: "destructive",
          description:
            status === 503
              ? "Mesin AI sedang tidak tersedia. Coba lagi nanti."
              : (e as Error).message || "Gagal merangkum percakapan.",
        });
      }
    }
  }

  async function handleSubmit() {
    if (!boardId || !title.trim()) return;
    // Kolom paling kiri = posisi terkecil.
    const leftmostColumnId =
      [...detail.columns].sort((a, b) => a.position - b.position)[0]?.id ?? null;

    setSubmitting(true);
    try {
      await detail.createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        columnId: leftmostColumnId,
        priority,
        dueDate: dueDate || undefined,
        tags: tags.trim() || undefined,
        // ── source ──
        sourceType: "chat",
        sourceChatId: chatId,
      });

      // refresh riwayat di sidebar
      queryClient.invalidateQueries({
        queryKey: ["/api/workboard/chats", chatId, "tasks"],
      });
      onClose();
    } catch {
      // createTask sudah menampilkan toast error sendiri (useBoardDetail).
    } finally {
      setSubmitting(false);
    }
  }

  const noBoards = boards.length === 0;
  const submitDisabled = !boardId || !title.trim() || detail.loading || submitting;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="w-4 h-4" />
            Buat Task dari Chat
          </DialogTitle>
        </DialogHeader>

        {/* Banner konteks */}
        <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-xs">
          <MessageCircle className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">
            Dari chat <b>{contactDisplayName}</b> ({contactPhone})
          </span>
        </div>

        {noBoards ? (
          <p className="text-sm text-muted-foreground py-4">
            Anda belum punya board. Buat board dulu di menu WorkBoard.
          </p>
        ) : (
          <div className="space-y-4 py-1">
            {/* Board */}
            <div className="space-y-1">
              <Label>Board *</Label>
              <Select
                value={boardId ? String(boardId) : undefined}
                onValueChange={(v) => setBoardId(Number(v))}
              >
                <SelectTrigger data-testid="select-task-board">
                  <SelectValue placeholder="Pilih board…" />
                </SelectTrigger>
                <SelectContent>
                  {boards.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.emoji ? `${b.emoji} ` : ""}
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                Card masuk ke kolom paling kiri board.
              </p>
            </div>

            {/* Judul */}
            <div className="space-y-1">
              <Label>Judul *</Label>
              <Input
                data-testid="input-task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Judul task"
              />
            </div>

            {/* Deskripsi + Generate AI */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Deskripsi</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="button-generate-ai"
                  onClick={handleGenerateAI}
                  disabled={aiState === "loading" || aiState === "nocredit"}
                  className="h-7 gap-1 text-xs"
                >
                  {aiState === "loading" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  {aiState === "loading"
                    ? "Generating"
                    : aiState === "done"
                      ? "Tulis ulang"
                      : "Generate AI"}
                </Button>
              </div>
              <Textarea
                data-testid="textarea-task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Deskripsi task"
              />
              {aiState === "done" && (
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                  Dirangkum AI · bisa diedit
                </p>
              )}
              {aiState === "nocredit" && (
                <p className="text-[10px] text-red-500">
                  Kredit AI habis — isi ulang untuk pakai rangkuman otomatis.
                </p>
              )}
            </div>

            {/* Priority */}
            <div className="space-y-1">
              <Label>Prioritas</Label>
              <div className="flex gap-2">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    data-testid={`chip-priority-${p.value}`}
                    onClick={() => setPriority(p.value)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs transition-colors ${
                      priority === p.value
                        ? "border-foreground bg-accent"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: p.color }}
                    />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Due date */}
            <div className="space-y-1">
              <Label>Jatuh Tempo</Label>
              <Input
                type="date"
                data-testid="input-task-duedate"
                value={dueDate ?? ""}
                onChange={(e) => setDueDate(e.target.value || null)}
              />
              <div className="flex gap-2 pt-1">
                {[
                  { label: "H+1", days: 1 },
                  { label: "H+2", days: 2 },
                  { label: "H+7", days: 7 },
                ].map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    data-testid={`chip-due-${s.label}`}
                    onClick={() => setDueDate(plusDays(s.days))}
                    className="px-2.5 py-1 rounded border border-border text-[11px] hover:bg-accent"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {dueDate && (
                <p className="text-[10px] text-muted-foreground">
                  Jatuh tempo: {formatDateId(dueDate)}
                </p>
              )}
            </div>

            {/* Tags */}
            <div className="space-y-1">
              <Label>Tags</Label>
              <Input
                data-testid="input-task-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Pisahkan dengan koma (mis. urgent, follow-up)"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Batal
          </Button>
          {!noBoards && (
            <Button
              data-testid="button-submit-task"
              onClick={handleSubmit}
              disabled={submitDisabled}
            >
              {submitting ? "Menyimpan…" : "Buat Task"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
