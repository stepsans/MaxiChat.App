import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useListChats,
  useDeleteChat,
  useOpenChatByPhone,
  useCreateGroup,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import type {} from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ChatAvatar } from "@/components/ChatAvatar";
import { useActiveChannel } from "@/contexts/ChannelContext";
import {
  Bot,
  UserCheck,
  Search,
  Flame,
  TrendingUp,
  Snowflake,
  MessageSquare,
  Trash2,
  Pin,
  Archive,
  Users,
  User,
  Filter,
  MessageSquarePlus,
  UsersRound,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { format, isToday, isYesterday, isThisYear, differenceInDays } from "date-fns";
import { id as idLocale } from "date-fns/locale";

function formatChatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "Kemarin";
  if (differenceInDays(new Date(), d) < 7) return format(d, "EEEE", { locale: idLocale });
  if (isThisYear(d)) return format(d, "dd/MM/yyyy");
  return format(d, "dd/MM/yyyy");
}

const tagColors: Record<string, string> = {
  hot_lead: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  cold: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  closing: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  none: "",
};

const tagIcons: Record<string, React.ElementType> = {
  hot_lead: Flame,
  cold: Snowflake,
  closing: TrendingUp,
};

interface Props {
  selectedChatId: number | null;
}

export default function ChatListPane({ selectedChatId }: Props) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"personal" | "group">("personal");
  const qc = useQueryClient();
  const { toast } = useToast();
  // Surface the per-chat channel badge only in the "All channels" view —
  // when the user has focused a single channel the badge is redundant.
  const { activeChannelId, channels } = useActiveChannel();
  const showChannelBadge = activeChannelId === "all" && (channels?.length ?? 0) > 1;
  const channelById = new Map((channels ?? []).map((c) => [c.id, c]));

  const { data: chats, isLoading } = useListChats(
    {},
    { query: { queryKey: getListChatsQueryKey(), refetchInterval: 5000 } }
  );

  const deleteChat = useDeleteChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        toast({ title: "Chat dihapus." });
      },
      onError: () => {
        toast({ title: "Gagal menghapus chat.", variant: "destructive" });
      },
    },
  });

  const handleDelete = (e: React.MouseEvent, chatId: number, contactName: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      window.confirm(
        `Hapus chat dengan ${contactName}? Semua pesan dalam chat ini akan ikut terhapus.`
      )
    ) {
      deleteChat.mutate({ id: chatId });
    }
  };

  const isGroupChat = (c: { phoneNumber: string }) => c.phoneNumber.endsWith("@g.us");
  const allChats = chats ?? [];
  const personalCount = allChats.filter((c) => !isGroupChat(c)).length;
  const groupCount = allChats.length - personalCount;

  const filtered = allChats.filter((c) => {
    const matchScope = scope === "group" ? isGroupChat(c) : !isGroupChat(c);
    const matchStatus = statusFilter === "all" || c.status === statusFilter;
    const matchTag = tagFilter === "all" || c.tag === tagFilter;
    const matchSearch =
      !search ||
      c.contactName.toLowerCase().includes(search.toLowerCase()) ||
      (c.nickname?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
      c.phoneNumber.includes(search);
    return matchScope && matchStatus && matchTag && matchSearch;
  });

  const activeFilters =
    (statusFilter !== "all" ? 1 : 0) + (tagFilter !== "all" ? 1 : 0);

  return (
    <div className="flex flex-col h-full bg-[hsl(var(--wa-panel))] border-r border-[hsl(var(--wa-divider))]">
      {/* Panel header: titlebar */}
      <div className="flex items-center justify-between px-4 h-[60px] bg-[hsl(var(--wa-panel-header))] flex-shrink-0">
        <h1 className="text-lg font-medium text-foreground">Chats</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[hsl(var(--wa-meta))]">
            {allChats.length} total
          </span>
          <NewGroupButton />
          <NewChatButton />
        </div>
      </div>

      {/* Search + filter row */}
      <div className="px-3 py-2 flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
          <input
            data-testid="input-search-chats"
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-[hsl(var(--wa-panel-header))] text-sm text-foreground placeholder:text-[hsl(var(--wa-meta))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--wa-accent))]"
            placeholder="Cari atau mulai chat baru"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-testid="button-filters"
              className={cn(
                "relative h-9 w-9 rounded-lg flex items-center justify-center text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-[hsl(var(--wa-panel-header))] transition-colors",
                activeFilters > 0 && "text-[hsl(var(--wa-accent))]"
              )}
              aria-label="Filter"
            >
              <Filter className="w-4 h-4" />
              {activeFilters > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-[hsl(var(--wa-accent))] text-[9px] text-white flex items-center justify-center font-semibold">
                  {activeFilters}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs">Status</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={statusFilter} onValueChange={setStatusFilter}>
              <DropdownMenuRadioItem value="all">Semua</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="ai_handled">AI Handled</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="needs_human">Needs Human</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="closed">Closed</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Tag</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={tagFilter} onValueChange={setTagFilter}>
              <DropdownMenuRadioItem value="all">Semua</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="hot_lead">Hot Lead</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="cold">Cold</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="closing">Closing</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {activeFilters > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setStatusFilter("all");
                    setTagFilter("all");
                  }}
                >
                  Reset filter
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Personal / Grup tabs */}
      <div className="px-3 pb-2 flex-shrink-0">
        <Tabs value={scope} onValueChange={(v) => setScope(v as "personal" | "group")}>
          <TabsList className="grid grid-cols-2 w-full h-8 bg-[hsl(var(--wa-panel-header))] p-0.5">
            <TabsTrigger value="personal" data-testid="tab-personal" className="text-xs gap-1 h-7">
              <User className="w-3 h-3" />
              Personal
              <span className="text-[10px] opacity-70">{personalCount}</span>
            </TabsTrigger>
            <TabsTrigger value="group" data-testid="tab-group" className="text-xs gap-1 h-7">
              <Users className="w-3 h-3" />
              Grup
              <span className="text-[10px] opacity-70">{groupCount}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto wa-scroll">
        {isLoading ? (
          <div className="p-3 space-y-2">
            {Array(8).fill(0).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-md" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[hsl(var(--wa-meta))] px-6 text-center">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">
              {search || activeFilters > 0
                ? "Tidak ada hasil untuk filter saat ini"
                : scope === "group"
                  ? "Belum ada grup"
                  : "Belum ada chat personal"}
            </p>
          </div>
        ) : (
          <div>
            {filtered.map((chat) => {
              const TagIcon = tagIcons[chat.tag];
              const isSelected = selectedChatId === chat.id;
              const chatChannel =
                showChannelBadge && chat.channelId != null
                  ? channelById.get(chat.channelId)
                  : null;
              // Prefer pushName (stored in contactName) over the raw JID even
              // for LID chats — only fall back to the LID number when no
              // pushName has ever been received.
              const displayName =
                chat.nickname?.trim() ||
                chat.contactName ||
                chat.phoneNumber;
              const subtitle = isGroupChat(chat)
                ? "Grup"
                : chat.isLid
                  ? "Nomor belum tertaut"
                  : chat.phoneNumber;
              return (
                <Link
                  key={chat.id}
                  href={`/chats/${chat.id}`}
                  data-testid={`chat-list-item-${chat.id}`}
                  className={cn(
                    "group flex items-center gap-3 px-3 py-2.5 cursor-pointer border-l-[3px] transition-colors",
                    isSelected
                      ? "bg-[hsl(var(--wa-panel-header))] border-l-[hsl(var(--wa-accent))]"
                      : "border-l-transparent hover:bg-[hsl(var(--wa-panel-header))]/60"
                  )}
                >
                  <ChatAvatar
                    name={displayName}
                    profilePicUrl={chat.profilePicUrl}
                    isGroup={isGroupChat(chat)}
                    isUnknown={chat.isLid && !chat.nickname?.trim()}
                    size={49}
                  />
                  <div className="flex-1 min-w-0 border-b border-[hsl(var(--wa-divider))] group-last:border-b-0 py-1.5">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      {chatChannel && (
                        <span
                          className="inline-block w-2 h-2 rounded-full flex-shrink-0 ring-1 ring-background self-center"
                          style={{ backgroundColor: chatChannel.color }}
                          title={chatChannel.label}
                          aria-label={`Channel: ${chatChannel.label}`}
                          data-testid={`chat-channel-dot-${chat.id}`}
                        />
                      )}
                      <span className="text-[15px] font-normal text-foreground truncate flex-1">
                        {displayName}
                      </span>
                      {chat.lastMessageAt && (
                        <span
                          className={cn(
                            "text-[11px] tabular-nums flex-shrink-0",
                            (chat.unreadCount ?? 0) > 0
                              ? "text-[hsl(var(--wa-accent))]"
                              : "text-[hsl(var(--wa-meta))]"
                          )}
                          title={format(new Date(chat.lastMessageAt), "d MMMM yyyy HH:mm", {
                            locale: idLocale,
                          })}
                        >
                          {formatChatTimestamp(chat.lastMessageAt)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mb-0.5">
                      {chat.pinnedAt && (
                        <Pin className="w-3 h-3 text-[hsl(var(--wa-meta))] flex-shrink-0" />
                      )}
                      {chat.isArchived && (
                        <Archive className="w-3 h-3 text-[hsl(var(--wa-meta))] flex-shrink-0" />
                      )}
                      <p className="text-[13px] text-[hsl(var(--wa-meta))] truncate flex-1">
                        {chat.lastMessage ?? subtitle}
                      </p>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {chat.status === "needs_human" && (
                          <Badge
                            variant="outline"
                            className="text-[9px] h-4 px-1 bg-yellow-500/15 text-yellow-300 border-yellow-500/30 gap-0.5"
                          >
                            <UserCheck className="w-2.5 h-2.5" />
                          </Badge>
                        )}
                        {chat.status === "ai_handled" && (
                          <Badge
                            variant="outline"
                            className="text-[9px] h-4 px-1 bg-[hsl(var(--wa-accent))]/15 text-[hsl(var(--wa-accent))] border-[hsl(var(--wa-accent))]/30 gap-0.5"
                          >
                            <Bot className="w-2.5 h-2.5" />
                          </Badge>
                        )}
                        {chat.tag !== "none" && TagIcon && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] h-4 w-4 p-0 flex items-center justify-center",
                              tagColors[chat.tag]
                            )}
                          >
                            <TagIcon className="w-2.5 h-2.5" />
                          </Badge>
                        )}
                        {(chat.unreadCount ?? 0) > 0 && (
                          <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[hsl(var(--wa-accent))] text-white text-[11px] flex items-center justify-center font-medium">
                            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid={`delete-chat-${chat.id}`}
                          onClick={(e) => handleDelete(e, chat.id, chat.contactName)}
                          disabled={deleteChat.isPending}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[hsl(var(--wa-meta))] hover:text-red-400 transition-opacity disabled:opacity-50"
                          aria-label="Delete chat"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Normalises a user-typed phone number to an E.164-ish digits-only string
 * suitable for https://wa.me/<number>. Indonesian conventions:
 *   - "08123…"  → "628123…"  (drop leading 0, prepend country code)
 *   - "+62…"    → "62…"
 *   - "8123…"   → "628123…"  (bare local mobile prefix → assume ID)
 *   - already-international ("62…", "1…", "44…") is left alone
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("8") && digits.length >= 9 && digits.length <= 13) {
    return "62" + digits;
  }
  return digits;
}

function NewChatButton() {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const normalised = normalisePhone(phone);
  const isValid = normalised.length >= 8 && normalised.length <= 15;

  const openChat = useOpenChatByPhone({
    mutation: {
      onSuccess: (result) => {
        // Refresh the chat list so a newly created chat appears immediately
        // (and re-orders if an existing one was just "reopened").
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        setOpen(false);
        setPhone("");
        if (result.created) {
          toast({ title: "Chat baru dibuat", description: result.phoneNumber });
        }
        navigate(`/chats/${result.chatId}`);
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal membuka chat",
          description:
            err instanceof Error ? err.message : "Periksa koneksi WhatsApp Anda.",
          variant: "destructive",
        });
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || openChat.isPending) return;
    openChat.mutate({ data: { phoneNumber: phone } });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPhone("");
      }}
    >
      <button
        type="button"
        data-testid="button-new-chat"
        onClick={() => setOpen(true)}
        aria-label="Mulai chat baru"
        title="Mulai chat baru"
        className="h-9 w-9 rounded-lg flex items-center justify-center text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-[hsl(var(--wa-panel))] transition-colors"
      >
        <MessageSquarePlus className="w-4 h-4" />
      </button>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Mulai chat baru</DialogTitle>
          <DialogDescription>
            Masukkan nomor WhatsApp tujuan. Jika chat dengan nomor ini sudah
            ada di history, room-nya akan langsung dibuka. Jika belum, room
            baru akan dibuat.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="new-chat-phone" className="text-xs font-medium">
              Nomor WhatsApp
            </label>
            <input
              id="new-chat-phone"
              data-testid="input-new-chat-phone"
              type="tel"
              autoFocus
              inputMode="tel"
              placeholder="cth. 08123456789 atau +628123456789"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {phone && (
              <p className="text-[11px] text-muted-foreground">
                {isValid ? (
                  <>
                    Nomor tujuan:{" "}
                    <code className="text-foreground">+{normalised}</code>
                  </>
                ) : (
                  "Nomor belum valid. Gunakan format 08xx, 62xx, atau +62xx."
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Batal
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="button-open-chat"
              disabled={!isValid || openChat.isPending}
            >
              {openChat.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              Buka chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewGroupButton() {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [phones, setPhones] = useState("");
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const parsedPhones = phones
    .split(/[\s,;\n]+/)
    .map((p) => p.replace(/[^0-9]/g, ""))
    .filter(Boolean);
  const isValid = subject.trim().length > 0 && parsedPhones.length > 0;

  const createGroup = useCreateGroup({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        setOpen(false);
        setSubject("");
        setPhones("");
        toast({ title: "Grup dibuat", description: result.subject });
        if (result.chatId != null) navigate(`/chats/${result.chatId}`);
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal membuat grup",
          description:
            err instanceof Error ? err.message : "Periksa koneksi WhatsApp Anda.",
          variant: "destructive",
        });
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || createGroup.isPending) return;
    createGroup.mutate({
      data: { subject: subject.trim(), phones: parsedPhones },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setSubject("");
          setPhones("");
        }
      }}
    >
      <button
        type="button"
        data-testid="button-new-group"
        onClick={() => setOpen(true)}
        aria-label="Buat grup baru"
        title="Buat grup baru"
        className="h-9 w-9 rounded-lg flex items-center justify-center text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-[hsl(var(--wa-panel))] transition-colors"
      >
        <UsersRound className="w-4 h-4" />
      </button>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Buat grup baru</DialogTitle>
          <DialogDescription>
            Ini akan membuat grup WhatsApp asli di akun yang terhubung dan
            mengundang nomor-nomor di bawah.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="new-group-subject" className="text-xs font-medium">
              Nama grup
            </label>
            <input
              id="new-group-subject"
              data-testid="input-new-group-subject"
              type="text"
              autoFocus
              placeholder="cth. Tim Penjualan"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="new-group-phones" className="text-xs font-medium">
              Nomor anggota
            </label>
            <Textarea
              id="new-group-phones"
              data-testid="input-new-group-phones"
              placeholder="cth. 628123456789, 628987654321 (pisah dengan koma/baris baru)"
              value={phones}
              onChange={(e) => setPhones(e.target.value)}
              className="min-h-[70px] text-sm"
            />
            {parsedPhones.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {parsedPhones.length} nomor terdeteksi.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Batal
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="button-create-group"
              disabled={!isValid || createGroup.isPending}
            >
              {createGroup.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              Buat grup
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
