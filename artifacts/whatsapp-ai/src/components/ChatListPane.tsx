import { useState } from "react";
import { Link } from "wouter";
import {
  useListChats,
  useDeleteChat,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import type {} from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ChatAvatar } from "@/components/ChatAvatar";
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
  cold: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  closing: "bg-violet-500/15 text-violet-300 border-violet-500/30",
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
        <div className="text-xs text-[hsl(var(--wa-meta))]">
          {allChats.length} total
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
              const displayName =
                chat.nickname?.trim() ||
                (chat.isLid ? chat.phoneNumber : chat.contactName);
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
