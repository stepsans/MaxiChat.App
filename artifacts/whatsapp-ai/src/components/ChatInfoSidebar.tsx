import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomerLabels,
  useSetChatLabels,
  useListShortcuts,
  useSendShortcutToChat,
  getListShortcutsQueryKey,
  getGetChatQueryKey,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import type { TextShortcut } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  PanelRightClose,
  Maximize2,
  Minimize2,
  Tag as TagIcon,
  Check,
  Plus,
  Zap,
  Package,
  Receipt,
  Search,
  Send,
  ImageIcon,
  Loader2,
} from "lucide-react";

export type ChatLabel = { id: number; name: string; color: string };

type AgentLike = {
  id: number;
  name?: string | null;
  email: string;
  teamRole?: string | null;
  status: string;
};

type ChatLike = {
  id: number;
  channelId: number;
  nickname?: string | null;
  contactName: string;
  phoneNumber: string;
  company?: string | null;
  labels: ChatLabel[];
  tag: string;
  status: string;
  isHumanTakeover: boolean;
  assignedUserId?: number | null;
};

interface Props {
  chatId: number;
  chat: ChatLike;
  canAssign: boolean;
  agents: AgentLike[];
  onClose: () => void;
  onUpdate: (data: {
    nickname?: string | null;
    company?: string | null;
    tag?: string;
    status?: string;
  }) => void;
  onTakeover: (checked: boolean) => void;
  onAssign: (userId: number | null) => void;
}

// Contrast helper: pick black/white text for a given hex background so label
// chips stay readable regardless of the chosen color.
function readableText(hex: string): string {
  const m = hex.replace("#", "");
  const full =
    m.length === 3
      ? m.split("").map((c) => c + c).join("")
      : m.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center text-[hsl(var(--wa-meta))]">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs">Segera hadir.</p>
    </div>
  );
}

// Shortcut tab: searchable list of the owner's text shortcuts. Each row can be
// sent to the active chat. Shortcuts carrying a `link` are delivered as a photo
// (with the replacement text as caption); the rest are sent as plain text.
function ShortcutTab({
  chatId,
  channelId,
}: {
  chatId: number;
  channelId: number;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data, isLoading } = useListShortcuts({
    query: { queryKey: getListShortcutsQueryKey() },
  });
  const shortcuts = (data ?? []) as TextShortcut[];

  const send = useSendShortcutToChat();

  // Mirror the server's channel-scope rule: a shortcut with no channel
  // assignments is global; one with assignments is only available on the listed
  // channels. Hide shortcuts not sendable on the active chat's channel.
  const inScope = shortcuts.filter(
    (s) => s.channelIds.length === 0 || s.channelIds.includes(channelId)
  );

  const q = search.trim().toLowerCase();
  const filtered = q
    ? inScope.filter(
        (s) =>
          s.shortcut.toLowerCase().includes(q) ||
          s.replacement.toLowerCase().includes(q)
      )
    : inScope;

  async function handleSend() {
    if (selectedId == null) return;
    try {
      await send.mutateAsync({ id: chatId, data: { shortcutId: selectedId } });
      setSelectedId(null);
    } catch (err) {
      toast({
        title: "Gagal mengirim shortcut",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col p-3 gap-3 min-h-0">
      <div className="relative flex-shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
        <Input
          data-testid="input-shortcut-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari shortcut…"
          className="h-9 pl-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-6">
          {shortcuts.length === 0
            ? "Belum ada shortcut. Tambahkan di Pengaturan."
            : "Tidak ada shortcut yang cocok."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
          {filtered.map((s) => {
            const isSelected = selectedId === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid={`shortcut-item-${s.id}`}
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelectedId((cur) => (cur === s.id ? null : s.id))
                  }
                  className={cn(
                    "w-full text-left rounded-lg border p-2.5 space-y-1.5 transition-colors",
                    isSelected
                      ? "border-[hsl(var(--wa-accent))] bg-[hsl(var(--wa-accent))]/10"
                      : "border-[hsl(var(--wa-divider))] hover:bg-white/5"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono text-[11px] bg-white/5 px-1.5 py-0.5 rounded text-foreground">
                      {s.shortcut}
                    </code>
                    {s.link ? (
                      <span
                        data-testid={`shortcut-photo-badge-${s.id}`}
                        className="inline-flex items-center gap-1 text-[10px] text-[hsl(var(--wa-accent))]"
                        title="Dikirim sebagai foto"
                      >
                        <ImageIcon className="w-3 h-3" /> Foto
                      </span>
                    ) : null}
                    {isSelected ? (
                      <Check className="w-3.5 h-3.5 text-[hsl(var(--wa-accent))] ml-auto" />
                    ) : null}
                  </div>
                  <p className="text-xs text-[hsl(var(--wa-meta))] line-clamp-2 whitespace-pre-wrap break-words">
                    {s.replacement}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        data-testid="button-send-shortcut"
        onClick={handleSend}
        disabled={selectedId == null || send.isPending}
        className="h-9 w-full gap-1.5 text-xs flex-shrink-0"
      >
        {send.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
        Kirim
      </Button>
    </div>
  );
}

export function ChatInfoSidebar({
  chatId,
  chat,
  canAssign,
  agents,
  onClose,
  onUpdate,
  onTakeover,
  onAssign,
}: Props) {
  const qc = useQueryClient();
  const [maximized, setMaximized] = useState(false);
  const [tab, setTab] = useState<"info" | "shortcut" | "products" | "order">(
    "info"
  );

  // Local, debounced-on-blur editing for free-text fields so each keystroke
  // doesn't fire a PATCH. Re-sync whenever the chat row changes underneath.
  const [name, setName] = useState(chat.nickname ?? "");
  const [company, setCompany] = useState(chat.company ?? "");
  useEffect(() => {
    setName(chat.nickname ?? "");
  }, [chat.id, chat.nickname]);
  useEffect(() => {
    setCompany(chat.company ?? "");
  }, [chat.id, chat.company]);

  const { data: allLabels } = useListCustomerLabels({
    query: { queryKey: ["/api/customer-labels"] },
  });
  const setLabels = useSetChatLabels({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  const selectedIds = new Set(chat.labels.map((l) => l.id));

  function toggleLabel(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setLabels.mutate({ id: chatId, data: { labelIds: Array.from(next) } });
  }

  function commitName() {
    const trimmed = name.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    if (normalized !== (chat.nickname ?? null)) {
      onUpdate({ nickname: normalized });
    }
  }

  function commitCompany() {
    const trimmed = company.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    if (normalized !== (chat.company ?? null)) {
      onUpdate({ company: normalized });
    }
  }

  return (
    <aside
      className={cn(
        "flex-shrink-0 border-l border-[hsl(var(--wa-divider))] bg-[hsl(var(--wa-panel-header))] flex flex-col transition-[width] duration-200",
        maximized ? "w-[420px]" : "w-72"
      )}
      data-testid="chat-info-panel"
    >
      <div className="h-[60px] flex items-center justify-between px-3 border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        <p className="text-sm font-medium">Info Chat</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="button-toggle-maximize-info-panel"
            onClick={() => setMaximized((m) => !m)}
            className="p-1.5 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors"
            title={maximized ? "Perkecil panel" : "Perbesar panel"}
          >
            {maximized ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            data-testid="button-close-info-panel"
            onClick={onClose}
            className="p-1.5 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors"
            title="Sembunyikan panel"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        {([
          { key: "info", label: "Info", icon: TagIcon },
          { key: "shortcut", label: "Shortcut", icon: Zap },
          { key: "products", label: "Produk", icon: Package },
          { key: "order", label: "Order", icon: Receipt },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`tab-info-${t.key}`}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium border-b-2 transition-colors",
              tab === t.key
                ? "border-[hsl(var(--wa-accent))] text-foreground"
                : "border-transparent text-[hsl(var(--wa-meta))] hover:text-foreground"
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {tab === "info" ? (
          <div className="p-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Nama
              </Label>
              <Input
                data-testid="input-chat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder={chat.contactName || chat.phoneNumber}
                className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Perusahaan
              </Label>
              <Input
                data-testid="input-chat-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onBlur={commitCompany}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="Nama perusahaan…"
                className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Label Customer
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {chat.labels.map((l) => (
                  <span
                    key={l.id}
                    data-testid={`chip-label-${l.id}`}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ backgroundColor: l.color, color: readableText(l.color) }}
                  >
                    {l.name}
                  </span>
                ))}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      data-testid="button-add-label"
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--wa-divider))] px-2 py-0.5 text-[11px] text-[hsl(var(--wa-meta))] hover:text-foreground hover:border-[hsl(var(--wa-meta))] transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Label
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 p-1">
                    {!allLabels || allLabels.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-center text-[hsl(var(--wa-meta))]">
                        Belum ada label. Buat di Pengaturan.
                      </p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto">
                        {allLabels.map((l) => {
                          const active = selectedIds.has(l.id);
                          return (
                            <button
                              key={l.id}
                              type="button"
                              data-testid={`option-label-${l.id}`}
                              onClick={() => toggleLabel(l.id)}
                              disabled={setLabels.isPending}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                            >
                              <span
                                className="h-3 w-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: l.color }}
                              />
                              <span className="flex-1 text-left truncate">
                                {l.name}
                              </span>
                              {active && <Check className="w-3.5 h-3.5" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Tag
              </Label>
              <Select
                value={chat.tag}
                onValueChange={(val) => onUpdate({ tag: val })}
              >
                <SelectTrigger
                  data-testid="select-chat-tag"
                  className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No tag</SelectItem>
                  <SelectItem value="hot_lead">Hot Lead</SelectItem>
                  <SelectItem value="cold">Cold</SelectItem>
                  <SelectItem value="closing">Closing</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Status
              </Label>
              <Select
                value={chat.status}
                onValueChange={(val) => onUpdate({ status: val })}
              >
                <SelectTrigger
                  data-testid="select-chat-status"
                  className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai_handled">AI Handled</SelectItem>
                  <SelectItem value="needs_human">Needs Human</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Mode Balas
              </Label>
              <div className="flex items-center justify-between gap-2 px-3 h-9 rounded-md border border-[hsl(var(--wa-divider))]">
                <Label
                  htmlFor="takeover"
                  className="text-xs text-foreground cursor-pointer"
                >
                  Manual
                </Label>
                <Switch
                  data-testid="switch-human-takeover"
                  id="takeover"
                  checked={chat.isHumanTakeover}
                  onCheckedChange={(checked) => onTakeover(checked)}
                />
              </div>
              <p className="text-[10px] text-[hsl(var(--wa-meta))]">
                Aktifkan untuk menonaktifkan balasan AI di chat ini.
              </p>
            </div>

            {canAssign && (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                  Ditugaskan ke
                </Label>
                <Select
                  value={
                    chat.assignedUserId == null
                      ? "__unassigned"
                      : String(chat.assignedUserId)
                  }
                  onValueChange={(v) =>
                    onAssign(v === "__unassigned" ? null : Number(v))
                  }
                >
                  <SelectTrigger
                    data-testid="select-chat-assign"
                    className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                  >
                    <SelectValue placeholder="Assign…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned">Belum di-assign</SelectItem>
                    {agents
                      .filter((a) => a.status === "active")
                      .map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name ?? a.email}
                          {a.teamRole === "supervisor" ? " (Supv)" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        ) : tab === "shortcut" ? (
          <ShortcutTab chatId={chatId} channelId={chat.channelId} />
        ) : tab === "products" ? (
          <ComingSoon label="Produk" />
        ) : (
          <ComingSoon label="Sales Order" />
        )}
      </div>
    </aside>
  );
}
