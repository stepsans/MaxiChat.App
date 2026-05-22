import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStatuses,
  usePostStatus,
  useDeleteStatus,
  getListStatusesQueryKey,
} from "@workspace/api-client-react";
import type { WhatsappStatus2, WhatsappStatusAuthor } from "@workspace/api-client-react";
import { formatDistanceToNowStrict } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Loader2, Plus, X, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { ChatAvatar } from "@/components/ChatAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const STATUS_COLORS = [
  "#128c7e",
  "#005c4b",
  "#075e54",
  "#0f3a4d",
  "#7e1f86",
  "#b54705",
  "#9c1a1a",
  "#1f3a5f",
];

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), {
      addSuffix: true,
      locale: idLocale,
    });
  } catch {
    return "";
  }
}

function StatusComposer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [color, setColor] = useState(STATUS_COLORS[0]);

  const post = usePostStatus({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListStatusesQueryKey() });
        toast({ title: "Status terkirim." });
        onClose();
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal mengirim status",
          description: err instanceof Error ? err.message : "Coba lagi nanti",
          variant: "destructive",
        });
      },
    },
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="bg-[hsl(var(--wa-panel))] border border-border rounded-lg w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 h-12 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Buat status</h2>
          <button
            onClick={onClose}
            data-testid="button-close-composer"
            className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-sidebar-accent"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className="aspect-[3/4] flex items-center justify-center p-8 transition-colors"
          style={{ backgroundColor: color }}
          data-testid="status-preview"
        >
          <Textarea
            data-testid="textarea-status-text"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 700))}
            placeholder="Ketik status..."
            rows={5}
            className={cn(
              "bg-transparent border-0 text-white text-2xl font-semibold text-center resize-none",
              "placeholder:text-white/60 focus-visible:ring-0 focus-visible:ring-offset-0",
              "shadow-none"
            )}
            autoFocus
          />
        </div>

        <div className="p-4 space-y-3 border-t border-border">
          <div>
            <p className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wide">
              Warna latar
            </p>
            <div className="flex flex-wrap gap-2">
              {STATUS_COLORS.map((c) => (
                <button
                  key={c}
                  data-testid={`color-${c.slice(1)}`}
                  onClick={() => setColor(c)}
                  className={cn(
                    "w-8 h-8 rounded-full border-2 transition-all",
                    color === c
                      ? "border-white scale-110"
                      : "border-transparent hover:scale-105"
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={`Pilih warna ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {text.length}/700
            </span>
            <Button
              data-testid="button-post-status"
              onClick={() =>
                post.mutate({ data: { text: text.trim(), backgroundColor: color } })
              }
              disabled={!text.trim() || post.isPending}
              className="bg-primary text-primary-foreground"
            >
              {post.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              Kirim
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusViewer({
  author,
  onClose,
  onDelete,
}: {
  author: WhatsappStatusAuthor;
  onClose: () => void;
  onDelete: (id: number) => void;
}) {
  const [idx, setIdx] = useState(0);
  const list = author.statuses;
  const current = list[idx];

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      if (idx + 1 < list.length) setIdx(idx + 1);
      else onClose();
    }, 5000);
    return () => clearTimeout(timer);
  }, [idx, list.length, current, onClose]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Progress bars */}
      <div className="px-4 pt-3 flex gap-1">
        {list.map((_, i) => (
          <div
            key={i}
            className="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden"
          >
            <div
              className={cn(
                "h-full bg-white transition-all",
                i < idx ? "w-full" : i === idx ? "w-full animate-[progress_5s_linear]" : "w-0"
              )}
            />
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3">
        <ChatAvatar
          profilePicUrl={author.profilePicUrl}
          name={author.authorName}
          isGroup={false}
          size={36}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{author.authorName}</p>
          <p className="text-[11px] text-white/70">{formatRelative(current.postedAt)}</p>
        </div>
        {author.isMine && (
          <button
            data-testid={`button-delete-status-${current.id}`}
            onClick={() => onDelete(current.id)}
            className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-white/10 text-white"
            aria-label="Hapus status"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        <button
          data-testid="button-close-viewer"
          onClick={onClose}
          className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-white/10 text-white"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center relative">
        {idx > 0 && (
          <button
            onClick={() => setIdx(idx - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
            aria-label="Sebelumnya"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {idx + 1 < list.length && (
          <button
            onClick={() => setIdx(idx + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
            aria-label="Selanjutnya"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        {current.statusType === "text" && (
          <div
            className="w-full max-w-md aspect-[3/4] mx-4 flex items-center justify-center p-8 rounded-lg"
            style={{ backgroundColor: current.backgroundColor ?? "#128c7e" }}
          >
            <p className="text-white text-2xl font-semibold text-center break-words whitespace-pre-wrap">
              {current.textContent}
            </p>
          </div>
        )}
        {current.statusType === "image" && current.mediaUrl && (
          <div className="flex flex-col items-center max-h-full max-w-full">
            <img
              src={current.mediaUrl}
              alt="Status"
              className="max-h-[75vh] max-w-full object-contain"
            />
            {current.caption && (
              <p className="text-white text-sm mt-3 text-center px-4 max-w-md">
                {current.caption}
              </p>
            )}
          </div>
        )}
        {current.statusType === "video" && current.mediaUrl && (
          <video
            src={current.mediaUrl}
            controls
            autoPlay
            className="max-h-[75vh] max-w-full"
          />
        )}
        {current.statusType !== "text" && !current.mediaUrl && (
          <div className="text-white/60 text-sm">Media belum tersedia</div>
        )}
      </div>
    </div>
  );
}

export default function StatusPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListStatuses({
    query: { queryKey: getListStatusesQueryKey(), refetchInterval: 15000 },
  });
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerAuthor, setViewerAuthor] = useState<WhatsappStatusAuthor | null>(null);

  const remove = useDeleteStatus({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListStatusesQueryKey() });
        toast({ title: "Status dihapus." });
      },
    },
  });

  const mine = useMemo(() => data?.find((a) => a.isMine) ?? null, [data]);
  const others = useMemo(() => (data ?? []).filter((a) => !a.isMine), [data]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[hsl(var(--wa-conversation))]">
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0 bg-[hsl(var(--wa-panel-header))]">
        <div>
          <h1 className="text-base font-semibold text-foreground">Status</h1>
          <p className="text-xs text-muted-foreground">
            Postingan status dari kontak Anda — hilang otomatis setelah 24 jam.
          </p>
        </div>
        <Button
          data-testid="button-open-composer"
          onClick={() => setComposerOpen(true)}
          className="bg-primary text-primary-foreground gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Buat status
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto wa-scroll p-6 space-y-6">
        {/* My Status */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Status Saya
          </h2>
          <button
            data-testid="my-status-card"
            onClick={() => {
              if (mine && mine.statuses.length > 0) setViewerAuthor(mine);
              else setComposerOpen(true);
            }}
            className="flex items-center gap-3 w-full p-3 rounded-lg bg-[hsl(var(--wa-panel))] hover:bg-sidebar-accent transition-colors text-left"
          >
            <div className="relative">
              <ChatAvatar
                profilePicUrl={mine?.profilePicUrl ?? null}
                name="Saya"
                isGroup={false}
                size={49}
              />
              {!mine?.statuses.length && (
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-primary border-2 border-[hsl(var(--wa-panel))] flex items-center justify-center">
                  <Plus className="w-3 h-3 text-white" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Status Saya</p>
              <p className="text-xs text-muted-foreground">
                {mine && mine.statuses.length > 0
                  ? `${mine.statuses.length} status • ${formatRelative(
                      mine.statuses[mine.statuses.length - 1].postedAt
                    )}`
                  : "Ketuk untuk menambah update"}
              </p>
            </div>
          </button>
        </section>

        {/* Recent updates */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Pembaruan terbaru
          </h2>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Memuat status...
            </div>
          ) : others.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Belum ada status dari kontak.
              <br />
              <span className="text-xs">
                Status yang dikirim kontak Anda akan muncul di sini.
              </span>
            </div>
          ) : (
            <ul className="space-y-1">
              {others.map((author) => (
                <li key={author.authorJid}>
                  <button
                    data-testid={`status-author-${author.authorPhone}`}
                    onClick={() => setViewerAuthor(author)}
                    className="flex items-center gap-3 w-full p-3 rounded-lg hover:bg-sidebar-accent transition-colors text-left"
                  >
                    <div
                      className="rounded-full p-[2px]"
                      style={{
                        background:
                          "conic-gradient(from 0deg, #00a884, #25d366, #00a884)",
                      }}
                    >
                      <div className="rounded-full p-[2px] bg-[hsl(var(--wa-conversation))]">
                        <ChatAvatar
                          profilePicUrl={author.profilePicUrl}
                          name={author.authorName}
                          isGroup={false}
                          size={45}
                        />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {author.authorName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {author.statuses.length} status •{" "}
                        {formatRelative(
                          author.statuses[author.statuses.length - 1].postedAt
                        )}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {composerOpen && <StatusComposer onClose={() => setComposerOpen(false)} />}
      {viewerAuthor && (
        <StatusViewer
          author={viewerAuthor}
          onClose={() => setViewerAuthor(null)}
          onDelete={(id) => {
            remove.mutate({ id });
            setViewerAuthor(null);
          }}
        />
      )}

      <style>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
}
