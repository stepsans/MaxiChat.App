import { useState } from "react";
import { Link } from "wouter";
import {
  useListChats,
  useDeleteChat,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { format, isToday, isYesterday, isThisYear } from "date-fns";
import { id as idLocale } from "date-fns/locale";

function formatChatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return `Kemarin ${format(d, "HH:mm")}`;
  if (isThisYear(d)) return format(d, "d MMM HH:mm", { locale: idLocale });
  return format(d, "d MMM yyyy HH:mm", { locale: idLocale });
}

const statusColors: Record<string, string> = {
  ai_handled: "bg-primary/10 text-primary border-primary/20",
  needs_human: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  closed: "bg-slate-500/10 text-slate-400 border-slate-500/20",
};

const tagColors: Record<string, string> = {
  hot_lead: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  cold: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  closing: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  none: "",
};

const tagIcons: Record<string, React.ElementType> = {
  hot_lead: Flame,
  cold: Snowflake,
  closing: TrendingUp,
};

const statusLabels: Record<string, string> = {
  ai_handled: "AI Handled",
  needs_human: "Needs Human",
  closed: "Closed",
};

export default function Chats() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"personal" | "group">("personal");
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: chats, isLoading } = useListChats();

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

  const handleDelete = (
    e: React.MouseEvent,
    chatId: number,
    contactName: string
  ) => {
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Chats</h1>
          <p className="text-xs text-muted-foreground">
            {allChats.length} total conversations
          </p>
        </div>
      </div>

      {/* Tabs: Personal / Grup */}
      <div className="px-6 pt-3 border-b border-border flex-shrink-0">
        <Tabs value={scope} onValueChange={(v) => setScope(v as "personal" | "group")}>
          <TabsList className="grid grid-cols-2 w-full max-w-xs">
            <TabsTrigger value="personal" data-testid="tab-personal" className="gap-1.5">
              <User className="w-3.5 h-3.5" />
              Personal
              <span className="text-[10px] text-muted-foreground ml-0.5">
                {personalCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="group" data-testid="tab-group" className="gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Grup
              <span className="text-[10px] text-muted-foreground ml-0.5">
                {groupCount}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            data-testid="input-search-chats"
            className="pl-8 h-8 text-sm"
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger data-testid="select-status-filter" className="h-8 w-36 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="ai_handled">AI Handled</SelectItem>
            <SelectItem value="needs_human">Needs Human</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger data-testid="select-tag-filter" className="h-8 w-32 text-sm">
            <SelectValue placeholder="Tag" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tags</SelectItem>
            <SelectItem value="hot_lead">Hot Lead</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
            <SelectItem value="closing">Closing</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array(8)
              .fill(0)
              .map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-md" />
              ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">
              {search || statusFilter !== "all" || tagFilter !== "all"
                ? "Tidak ada hasil untuk filter saat ini"
                : scope === "group"
                  ? "Belum ada grup"
                  : "Belum ada chat personal"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((chat) => {
              const TagIcon = tagIcons[chat.tag];
              return (
                <Link
                  key={chat.id}
                  href={`/chats/${chat.id}`}
                  data-testid={`chat-list-item-${chat.id}`}
                  className="flex items-center gap-3 px-6 py-3.5 hover:bg-accent transition-colors cursor-pointer"
                >
                    {/* Avatar */}
                    <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 text-sm font-semibold text-foreground">
                      {isGroupChat(chat) ? (
                        <Users className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        chat.contactName.charAt(0).toUpperCase()
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        {chat.pinnedAt && (
                          <Pin className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        )}
                        {chat.isArchived && (
                          <Archive className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">{chat.contactName}</span>
                        {chat.nickname && chat.nickname !== chat.contactName && (
                          <span className="text-[11px] text-muted-foreground truncate">
                            ~ {chat.nickname}
                          </span>
                        )}
                        {chat.tag !== "none" && TagIcon && (
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] h-4 px-1.5", tagColors[chat.tag])}
                          >
                            <TagIcon className="w-2.5 h-2.5 mr-0.5" />
                            {chat.tag.replace("_", " ")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {chat.lastMessage ?? "No messages yet"}
                      </p>
                    </div>

                    {/* Right */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {chat.lastMessageAt && (
                        <span
                          className="text-[10px] text-muted-foreground tabular-nums"
                          title={format(new Date(chat.lastMessageAt), "d MMMM yyyy HH:mm", {
                            locale: idLocale,
                          })}
                        >
                          {formatChatTimestamp(chat.lastMessageAt)}
                        </span>
                      )}
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] h-4 px-1.5", statusColors[chat.status])}
                      >
                        {chat.status === "ai_handled" ? (
                          <Bot className="w-2.5 h-2.5 mr-0.5" />
                        ) : (
                          <UserCheck className="w-2.5 h-2.5 mr-0.5" />
                        )}
                        {statusLabels[chat.status]}
                      </Badge>
                      {chat.unreadCount > 0 && (
                        <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-bold">
                          {chat.unreadCount}
                        </span>
                      )}
                    </div>

                    {/* Delete button */}
                    <button
                      type="button"
                      data-testid={`delete-chat-${chat.id}`}
                      onClick={(e) => handleDelete(e, chat.id, chat.contactName)}
                      disabled={deleteChat.isPending}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0 disabled:opacity-50"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
