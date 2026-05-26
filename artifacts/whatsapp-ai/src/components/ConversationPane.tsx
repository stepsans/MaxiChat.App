import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetChat,
  useUpdateChat,
  useSendManualReply,
  useTakeoverChat,
  useRefreshChatAvatar,
  getGetChatQueryKey,
  getListChatsQueryKey,
  useListProducts,
  getListProductsQueryKey,
  useSendProductToChat,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatAvatar } from "@/components/ChatAvatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Bot,
  Send,
  UserCheck,
  Loader2,
  Paperclip,
  Image as ImageIcon,
  Video as VideoIcon,
  FileText,
  User as UserIcon,
  Download,
  Package,
  Smile,
  Mic,
  Check,
  CheckCheck,
  MoreVertical,
  Search,
  RefreshCw,
  X,
} from "lucide-react";
import { cn, resolveImageSrc } from "@/lib/utils";
import { format, isToday, isYesterday, isThisYear } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import { useShortcutMap, expandShortcuts } from "@/lib/shortcuts";

type MediaKind = "image" | "video" | "document";

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return "Hari ini";
  if (isYesterday(d)) return "Kemarin";
  if (isThisYear(d)) return format(d, "d MMMM", { locale: idLocale });
  return format(d, "d MMMM yyyy", { locale: idLocale });
}

export default function ConversationPane({ chatId }: { chatId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const refreshAvatar = useRefreshChatAvatar({
    mutation: {
      onSuccess: (result) => {
        // Always invalidate so the cached chat row picks up the new (or
        // explicitly-null) profilePicUrl. Toast distinguishes the two so the
        // user knows whether the contact actually has a picture available.
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        toast({
          title: result.profilePicUrl
            ? "Foto profil diperbarui"
            : "Foto tidak tersedia",
          description: result.profilePicUrl
            ? undefined
            : "Kontak mungkin menyembunyikan foto profilnya atau belum mengatur foto.",
        });
      },
      onError: (err) => {
        toast({
          title: "Gagal memperbarui foto",
          description:
            err instanceof Error ? err.message : "Coba lagi sebentar.",
          variant: "destructive",
        });
      },
    },
  });
  const [reply, setReply] = useState("");
  const shortcutMap = useShortcutMap();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [pendingFileKind, setPendingFileKind] = useState<MediaKind>("document");
  const [uploading, setUploading] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the in-chat search whenever we switch chats so the next room opens
  // clean instead of inheriting the previous chat's filter.
  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [chatId]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [sendingContact, setSendingContact] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [productPanelOpen, setProductPanelOpen] = useState(false);
  const [sendingProductId, setSendingProductId] = useState<number | null>(null);
  const [productSearch, setProductSearch] = useState("");

  const { data: products } = useListProducts({
    query: {
      queryKey: getListProductsQueryKey(),
      enabled: productPanelOpen,
    },
  });

  const formatIDR = (n: number) =>
    new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(n);

  const sendProductMut = useSendProductToChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        toast({ title: "Produk terkirim." });
        setProductPanelOpen(false);
      },
      onError: (err: any) =>
        toast({
          title: "Gagal mengirim produk",
          description: err?.message ?? "",
          variant: "destructive",
        }),
      onSettled: () => setSendingProductId(null),
    },
  });

  function handleSendProduct(productId: number) {
    setSendingProductId(productId);
    sendProductMut.mutate({ id: chatId, data: { productId } });
  }

  const acceptFor = (k: MediaKind) =>
    k === "image" ? "image/*" : k === "video" ? "video/*" : "*/*";

  function openFilePicker(kind: MediaKind) {
    setPendingFileKind(kind);
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (reply.trim()) fd.append("caption", reply.trim());
      const res = await fetch(`/api/chats/${chatId}/media`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Gagal mengirim media");
      }
      setReply("");
      qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      toast({ title: "Media terkirim." });
    } catch (err: any) {
      toast({
        title: "Gagal mengirim media",
        description: err?.message ?? "",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleSendContact() {
    if (!contactName.trim() || !contactPhone.trim()) return;
    setSendingContact(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contactName.trim(),
          phone: contactPhone.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Gagal mengirim kontak");
      }
      setContactOpen(false);
      setContactName("");
      setContactPhone("");
      qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      toast({ title: "Kontak terkirim." });
    } catch (err: any) {
      toast({
        title: "Gagal mengirim kontak",
        description: err?.message ?? "",
        variant: "destructive",
      });
    } finally {
      setSendingContact(false);
    }
  }

  const { data: chat, isLoading } = useGetChat(chatId, {
    query: {
      enabled: !!chatId,
      queryKey: getGetChatQueryKey(chatId),
      refetchInterval: 5000,
    },
  });

  const updateChat = useUpdateChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  const sendReply = useSendManualReply({
    mutation: {
      onSuccess: () => {
        setReply("");
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  const takeover = useTakeoverChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  // Mark list cache stale so unread badges clear when entering a chat.
  useEffect(() => {
    if (chat) {
      qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
    }
  }, [chat?.id]);

  // Autoscroll to the most recent message whenever new messages arrive — the
  // canonical WhatsApp UX (you always land at the bottom of the thread).
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [chat?.messages.length, chat?.id]);

  if (isLoading) {
    return (
      <div className="flex-1 wa-doodle-bg flex flex-col">
        <div className="h-[60px] bg-[hsl(var(--wa-panel-header))] border-b border-[hsl(var(--wa-divider))] flex items-center px-4 gap-3">
          <Skeleton className="w-10 h-10 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[hsl(var(--wa-meta))]" />
        </div>
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex-1 wa-doodle-bg flex items-center justify-center text-[hsl(var(--wa-meta))]">
        <p>Chat tidak ditemukan</p>
      </div>
    );
  }

  const isGroup = chat.phoneNumber.endsWith("@g.us");
  const displayName =
    chat.nickname?.trim() ||
    (chat.isLid ? chat.phoneNumber : chat.contactName);
  const subtitle = isGroup
    ? "Grup"
    : chat.isLid
      ? "Nomor belum tertaut"
      : chat.phoneNumber;

  // Apply in-chat search (client-side substring match on message text). Empty
  // query passes everything through. Media-only messages with no text are
  // hidden while a query is active — they have nothing to match against.
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const visibleMessages = trimmedQuery
    ? chat.messages.filter((m: any) =>
        typeof m.content === "string" &&
        m.content.toLowerCase().includes(trimmedQuery)
      )
    : chat.messages;

  // Group messages by day so we can drop a "Hari ini / Kemarin / d MMMM"
  // pill between them — same UX as WhatsApp.
  const messagesByDay: { day: string; messages: any[] }[] = [];
  for (const msg of visibleMessages) {
    const dayKey = format(new Date(msg.createdAt), "yyyy-MM-dd");
    const lastGroup = messagesByDay[messagesByDay.length - 1];
    if (lastGroup && lastGroup.day === dayKey) {
      lastGroup.messages.push(msg);
    } else {
      messagesByDay.push({ day: dayKey, messages: [msg] });
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[hsl(var(--wa-conversation))]">
      {/* Conversation header */}
      <div className="flex items-center gap-3 px-4 h-[60px] bg-[hsl(var(--wa-panel-header))] border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        <Link
          href="/chats"
          data-testid="button-back-to-chats"
          className="p-1.5 rounded-full hover:bg-white/5 transition-colors md:hidden"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <ChatAvatar
          name={displayName}
          profilePicUrl={chat.profilePicUrl}
          isGroup={isGroup}
          isUnknown={chat.isLid && !chat.nickname?.trim()}
          size={40}
        />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-medium text-foreground truncate leading-tight">
            {displayName}
          </p>
          <p className="text-[12px] text-[hsl(var(--wa-meta))] truncate">
            {chat.isHumanTakeover ? "Mode manual — AI dinonaktifkan" : subtitle}
          </p>
        </div>

        {/* Header actions */}
        <div className="flex items-center gap-2">
          <Select
            value={chat.tag}
            onValueChange={(val) =>
              updateChat.mutate({ id: chatId, data: { tag: val as any } })
            }
          >
            <SelectTrigger
              data-testid="select-chat-tag"
              className="h-8 w-28 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
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

          <Select
            value={chat.status}
            onValueChange={(val) =>
              updateChat.mutate({ id: chatId, data: { status: val as any } })
            }
          >
            <SelectTrigger
              data-testid="select-chat-status"
              className="h-8 w-32 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai_handled">AI Handled</SelectItem>
              <SelectItem value="needs_human">Needs Human</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5 px-2 h-8 rounded-md border border-[hsl(var(--wa-divider))]">
            <Switch
              data-testid="switch-human-takeover"
              id="takeover"
              checked={chat.isHumanTakeover}
              onCheckedChange={(checked) =>
                takeover.mutate({ id: chatId, data: { takeover: checked } })
              }
            />
            <Label htmlFor="takeover" className="text-[11px] text-[hsl(var(--wa-meta))] cursor-pointer">
              Manual
            </Label>
          </div>

          <Sheet open={productPanelOpen} onOpenChange={setProductPanelOpen}>
            <SheetTrigger asChild>
              <button
                data-testid="button-open-products"
                className="p-2 rounded-full hover:bg-white/5 text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors"
                title="Kirim Produk"
              >
                <Package className="w-4 h-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
              <SheetHeader className="px-4 py-3 border-b border-border">
                <SheetTitle className="text-sm">Kirim Produk</SheetTitle>
              </SheetHeader>
              <div className="px-4 py-2 border-b border-border">
                <Input
                  data-testid="input-product-search"
                  placeholder="Cari kode atau nama..."
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {!products ? (
                  <div className="text-xs text-muted-foreground text-center py-8">
                    Memuat produk...
                  </div>
                ) : products.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Package className="w-8 h-8 mb-2 opacity-30" />
                    <p className="text-xs">Belum ada produk</p>
                    <Link
                      href="/products"
                      className="text-xs text-primary underline mt-2"
                    >
                      Tambah di Katalog Produk
                    </Link>
                  </div>
                ) : (
                  products
                    .filter((p) => {
                      const q = productSearch.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        p.code.toLowerCase().includes(q) ||
                        p.name.toLowerCase().includes(q)
                      );
                    })
                    .map((p) => (
                      <div
                        key={p.id}
                        data-testid={`product-item-${p.id}`}
                        className="flex gap-3 p-2 rounded-md border border-border hover:bg-accent/50 transition-colors"
                      >
                        <div className="w-14 h-14 rounded-md bg-secondary flex-shrink-0 overflow-hidden flex items-center justify-center">
                          {p.imageUrl ? (
                            <img
                              src={resolveImageSrc(p.imageUrl) ?? p.imageUrl}
                              alt={p.name}
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <Package className="w-5 h-5 opacity-30" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {p.code}
                          </p>
                          <p className="text-xs font-medium line-clamp-2">{p.name}</p>
                          <p className="text-xs font-semibold text-primary">
                            {formatIDR(p.price)}
                          </p>
                        </div>
                        <Button
                          data-testid={`button-send-product-${p.id}`}
                          size="sm"
                          variant="default"
                          className="h-7 text-xs self-center"
                          disabled={sendingProductId !== null}
                          onClick={() => handleSendProduct(p.id)}
                        >
                          {sendingProductId === p.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Send className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                    ))
                )}
              </div>
            </SheetContent>
          </Sheet>

          <button
            className={cn(
              "p-2 rounded-full hover:bg-white/5 transition-colors",
              searchOpen
                ? "text-foreground bg-white/10"
                : "text-[hsl(var(--wa-meta))] hover:text-foreground"
            )}
            title="Cari pesan di chat ini"
            data-testid="button-chat-search"
            onClick={() => {
              setSearchOpen((v) => {
                const next = !v;
                if (!next) setSearchQuery("");
                if (next) {
                  // Focus after the input is rendered.
                  setTimeout(() => searchInputRef.current?.focus(), 0);
                }
                return next;
              });
            }}
          >
            <Search className="w-4 h-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-2 rounded-full hover:bg-white/5 text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors"
                title="Menu"
                data-testid="button-chat-menu"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="menu-refresh-avatar"
                disabled={refreshAvatar.isPending}
                onClick={() => refreshAvatar.mutate({ id: chatId })}
              >
                {refreshAvatar.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-2" />
                )}
                Refresh foto profil
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* In-chat search bar (toggled by the search button in the header). */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 h-12 bg-[hsl(var(--wa-panel-header))] border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
          <Search className="w-4 h-4 text-[hsl(var(--wa-meta))] shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder="Cari pesan di chat ini…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[hsl(var(--wa-meta))]"
            data-testid="input-chat-search"
          />
          {trimmedQuery && (
            <span className="text-[11px] text-[hsl(var(--wa-meta))] shrink-0">
              {visibleMessages.length} hasil
            </span>
          )}
          <button
            className="p-1.5 rounded-full hover:bg-white/5 text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors"
            title="Tutup pencarian"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Messages on doodle background */}
      <div className="flex-1 overflow-y-auto wa-scroll wa-doodle-bg px-[8%] py-4">
        {trimmedQuery && visibleMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-[hsl(var(--wa-meta))]">
              <p className="text-sm">Tidak ada pesan yang cocok</p>
            </div>
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-[hsl(var(--wa-meta))]">
              <p className="text-sm">Belum ada pesan</p>
            </div>
          </div>
        ) : (
          <>
            {messagesByDay.map((group) => (
              <div key={group.day}>
                <div className="flex justify-center my-3">
                  <span className="px-3 py-1 rounded-md bg-[hsl(var(--wa-panel-header))]/95 text-[12px] text-[hsl(var(--wa-meta))] shadow-sm">
                    {formatDayHeader(group.messages[0].createdAt)}
                  </span>
                </div>
                {group.messages.map((msg: any, idx: number) => {
                  const isOutbound = msg.direction === "outbound";
                  const prev = idx > 0 ? group.messages[idx - 1] : null;
                  const isCont = prev && prev.direction === msg.direction;
                  const mediaType: string | null = msg.mediaType ?? null;
                  const mediaUrl: string | null = msg.mediaUrl ?? null;
                  return (
                    <div
                      key={msg.id}
                      data-testid={`message-${msg.id}`}
                      className={cn(
                        "flex mb-0.5",
                        isOutbound ? "justify-end pl-12" : "justify-start pr-12",
                        isCont ? "mt-0.5" : "mt-2"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[65%] min-w-[80px] px-2 py-1 text-[14.2px] leading-[19px]",
                          isOutbound ? "wa-bubble-out" : "wa-bubble-in",
                          isCont && "wa-bubble-cont"
                        )}
                      >
                        {mediaType === "image" && mediaUrl && (
                          <button
                            type="button"
                            onClick={() => setLightboxUrl(mediaUrl)}
                            className="block mb-1 cursor-zoom-in"
                            data-testid={`image-preview-${msg.id}`}
                          >
                            <img
                              src={mediaUrl}
                              alt={msg.mediaFilename ?? "image"}
                              className="rounded-md max-h-72 object-cover"
                            />
                          </button>
                        )}
                        {mediaType === "video" && mediaUrl && (
                          <video
                            src={mediaUrl}
                            controls
                            className="rounded-md max-h-72 w-full mb-1"
                          />
                        )}
                        {mediaType === "audio" && mediaUrl && (
                          <audio src={mediaUrl} controls className="w-full mb-1" />
                        )}
                        {mediaType === "document" && mediaUrl && (
                          <a
                            href={mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            download={msg.mediaFilename ?? undefined}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-black/20 mb-1"
                          >
                            <FileText className="w-5 h-5 flex-shrink-0 opacity-80" />
                            <span className="truncate text-xs underline">
                              {msg.mediaFilename ?? "Document"}
                            </span>
                            <Download className="w-3.5 h-3.5 opacity-60 ml-auto" />
                          </a>
                        )}
                        {mediaType === "contact" && (
                          <div className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-black/20 mb-1">
                            <UserIcon className="w-5 h-5 flex-shrink-0 opacity-80" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">
                                {msg.mediaFilename ?? "Kontak"}
                              </p>
                              {msg.content && (
                                <p className="text-[10px] opacity-70 truncate">
                                  {msg.content}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                        {msg.content && mediaType !== "contact" && (
                          <p className="whitespace-pre-wrap break-words pr-14">
                            {msg.content}
                          </p>
                        )}
                        <div className="flex items-center justify-end gap-1 -mt-3 -mb-0.5 float-right pl-2">
                          {isOutbound && msg.isAiGenerated && (
                            <Bot
                              className="w-3 h-3 text-[hsl(var(--wa-meta))]"
                              aria-label="AI generated"
                            />
                          )}
                          <span className="text-[11px] text-[hsl(var(--wa-meta))] tabular-nums">
                            {format(new Date(msg.createdAt), "HH:mm")}
                          </span>
                          {isOutbound && (
                            <CheckCheck
                              className="w-3.5 h-3.5 text-[hsl(var(--wa-tick-read))]"
                              aria-label="Sent"
                            />
                          )}
                        </div>
                        <div className="clear-both" />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Composer */}
      <div className="px-4 py-2 bg-[hsl(var(--wa-panel-header))] flex-shrink-0">
        {chat.isHumanTakeover && (
          <p className="text-[11px] text-yellow-400 mb-1.5 flex items-center gap-1">
            <UserCheck className="w-3 h-3" />
            Mode manual — AI auto-reply dijeda untuk chat ini
          </p>
        )}
        <div className="flex items-end gap-2">
          <button
            className="p-2 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors"
            title="Emoji"
            type="button"
          >
            <Smile className="w-5 h-5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-testid="button-attach"
                type="button"
                className="p-2 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors disabled:opacity-50"
                disabled={uploading}
                title="Lampirkan"
              >
                {uploading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Paperclip className="w-5 h-5" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuItem
                data-testid="menu-attach-image"
                onClick={() => openFilePicker("image")}
              >
                <ImageIcon className="w-4 h-4 mr-2" /> Gambar
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="menu-attach-video"
                onClick={() => openFilePicker("video")}
              >
                <VideoIcon className="w-4 h-4 mr-2" /> Video
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="menu-attach-document"
                onClick={() => openFilePicker("document")}
              >
                <FileText className="w-4 h-4 mr-2" /> File / Dokumen
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="menu-attach-contact"
                onClick={() => setContactOpen(true)}
              >
                <UserIcon className="w-4 h-4 mr-2" /> Kontak
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={fileInputRef}
            type="file"
            accept={acceptFor(pendingFileKind)}
            onChange={handleFileSelected}
            className="hidden"
            data-testid="input-file"
          />

          <div className="flex-1 bg-[hsl(var(--wa-panel))] rounded-lg px-3 py-2">
            <textarea
              data-testid="textarea-reply"
              placeholder="Ketik pesan"
              value={reply}
              onChange={(e) => {
                // Inline shortcut expansion: every keystroke we expand any
                // "/token" that is now followed by whitespace. The trailing
                // /token (no whitespace yet) is left alone until send, so the
                // user can still finish typing it.
                const next = expandShortcuts(e.target.value, shortcutMap, false);
                setReply(next);
              }}
              rows={1}
              className="w-full bg-transparent text-[15px] text-foreground placeholder:text-[hsl(var(--wa-meta))] focus:outline-none resize-none max-h-32"
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 128) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const finalText = expandShortcuts(reply, shortcutMap, true).trim();
                  if (finalText) {
                    sendReply.mutate({
                      id: chatId,
                      data: { content: finalText },
                    });
                  }
                }
              }}
            />
          </div>

          <button
            data-testid="button-send-reply"
            type="button"
            onClick={() => {
              const finalText = expandShortcuts(reply, shortcutMap, true).trim();
              if (finalText) {
                sendReply.mutate({ id: chatId, data: { content: finalText } });
              }
            }}
            disabled={sendReply.isPending}
            className="p-2 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors disabled:opacity-50"
            title={reply.trim() ? "Kirim" : "Pesan suara"}
          >
            {sendReply.isPending ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : reply.trim() ? (
              <Send className="w-5 h-5 text-[hsl(var(--wa-accent))]" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>

      {/* Contact share dialog */}
      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kirim Kontak</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="contact-name" className="text-xs">Nama</Label>
              <Input
                id="contact-name"
                data-testid="input-contact-name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Nama kontak"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contact-phone" className="text-xs">Nomor WhatsApp</Label>
              <Input
                id="contact-phone"
                data-testid="input-contact-phone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+62812xxxxxxxx"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setContactOpen(false)}
              disabled={sendingContact}
            >
              Batal
            </Button>
            <Button
              data-testid="button-send-contact"
              onClick={handleSendContact}
              disabled={sendingContact || !contactName.trim() || !contactPhone.trim()}
            >
              {sendingContact ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Kirim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!lightboxUrl} onOpenChange={(open) => !open && setLightboxUrl(null)}>
        <DialogContent
          className="max-w-[95vw] w-auto p-0 bg-transparent border-0 shadow-none flex items-center justify-center"
          data-testid="image-lightbox"
        >
          {lightboxUrl && (
            <img
              src={lightboxUrl}
              alt="preview"
              className="max-h-[90vh] max-w-[95vw] w-auto h-auto object-contain rounded-md"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
