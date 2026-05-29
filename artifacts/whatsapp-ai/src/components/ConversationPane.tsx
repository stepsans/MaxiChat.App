import { useState, useEffect, useRef, type ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetChat,
  useUpdateChat,
  useSendManualReply,
  useTakeoverChat,
  useRefreshChatAvatar,
  useAssignChat,
  useListAgents,
  useGetMe,
  getGetChatQueryKey,
  getListChatsQueryKey,
  getListAgentsQueryKey,
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
  PanelRightOpen,
  PanelRightClose,
  Copy,
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
  // Image pasted (Ctrl/Cmd+V) or picked into a staging area. Held so the user
  // can add a caption before sending instead of firing off immediately.
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [pastedPreview, setPastedPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!pastedImage) {
      setPastedPreview(null);
      return;
    }
    const url = URL.createObjectURL(pastedImage);
    setPastedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pastedImage]);
  // Drop a staged paste whenever we switch chats so it can't leak across rooms.
  useEffect(() => {
    setPastedImage(null);
  }, [chatId]);
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
  // Right-side info panel that hosts Tag / Status / Manual / Assign.
  // Persist open/closed across reloads so the user's preference sticks.
  const [infoPanelOpen, setInfoPanelOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("chat-info-panel") !== "closed";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        "chat-info-panel",
        infoPanelOpen ? "open" : "closed",
      );
    }
  }, [infoPanelOpen]);

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

  async function uploadMedia(file: File, caption: string) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (caption.trim()) fd.append("caption", caption.trim());
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

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await uploadMedia(file, reply);
  }

  // Pull the first image out of a clipboard paste (e.g. a screenshot) and
  // stage it for sending. Returns true if an image was captured so the caller
  // can suppress the default text paste.
  function captureImageFromClipboard(
    items: DataTransferItemList | null | undefined,
  ): boolean {
    if (!items) return false;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          setPastedImage(file);
          return true;
        }
      }
    }
    return false;
  }

  // Send whatever is staged: a pasted image (with the text box as its caption)
  // takes priority, otherwise the typed text is sent as a normal message.
  function handleSend() {
    // Guard the keyboard path too (the button is disabled, Enter isn't) so an
    // in-flight upload/send can't be duplicated or run concurrently.
    if (uploading || sendReply.isPending) return;
    if (pastedImage) {
      const caption = expandShortcuts(reply, shortcutMap, true);
      const img = pastedImage;
      setPastedImage(null);
      void uploadMedia(img, caption);
      return;
    }
    const finalText = expandShortcuts(reply, shortcutMap, true).trim();
    if (finalText) {
      sendReply.mutate({ id: chatId, data: { content: finalText } });
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

  // Assignment: super_admin / supervisor can route a chat to a specific agent.
  // The team list (useListAgents) is cheap and shared across all open chats,
  // so it's fine to load it here unconditionally — the actual control is
  // hidden for the "agent" team role.
  const { data: me } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const teamRole = me?.user?.teamRole ?? "super_admin";
  const canAssign = teamRole === "super_admin" || teamRole === "supervisor";
  const { data: agentsData } = useListAgents({
    query: { queryKey: getListAgentsQueryKey(), enabled: canAssign },
  });
  const assignMut = useAssignChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal assign chat",
          description: err?.data?.error ?? err?.message ?? "Coba lagi.",
          variant: "destructive",
        });
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
  // Prefer pushName (stored in contactName) over the raw JID — even for LID
  // chats — so the header shows "Efendi" instead of a bare LID number when
  // WhatsApp has shared the contact's profile name.
  const displayName =
    chat.nickname?.trim() ||
    chat.contactName ||
    chat.phoneNumber;

  // Build a participants directory for this group chat by scanning every
  // message's sender info. Keyed by senderPhoneDigits (which may be a real
  // phone or a LID) — that same digit string is what appears inside an
  // "@628…" mention token, so the same map serves both
  //   (a) the per-bubble "sender name + avatar" header, and
  //   (b) resolving @mention tokens in the message body.
  const participantsByPhone = new Map<string, string>();
  for (const m of chat.messages as any[]) {
    const digits = typeof m.senderPhoneDigits === "string" ? m.senderPhoneDigits : null;
    const name = typeof m.senderName === "string" ? m.senderName.trim() : "";
    if (digits && name && !participantsByPhone.has(digits)) {
      participantsByPhone.set(digits, name);
    }
  }

  // Pick a stable per-sender colour so the same participant always wears
  // the same hue across their bubbles — same UX as WhatsApp's group view.
  const SENDER_COLOURS = [
    "#06cf9c", "#f87171", "#60a5fa", "#fbbf24", "#c084fc",
    "#fb7185", "#34d399", "#f472b6", "#22d3ee", "#a3e635",
  ];
  const colourForSender = (key: string): string => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return SENDER_COLOURS[h % SENDER_COLOURS.length];
  };

  // Resolve a raw mention digits string to the best display label we have:
  // first the group-local participant we just collected, then the owner's
  // own chats list (so mentioning a known contact from another 1:1 still
  // renders nicely), else fall back to the digits as-is.
  const resolveMentionLabel = (digits: string): string => {
    const fromParticipants = participantsByPhone.get(digits);
    if (fromParticipants) return fromParticipants;
    return digits;
  };

  // Render a message body, swapping every "@<digits>" token for the
  // resolved nickname (highlighted as a chip-like span). Splits the text
  // on the mention regex so React can interleave plain strings with
  // styled <span> elements without dangerouslySetInnerHTML.
  const renderBodyWithMentions = (text: string): ReactNode => {
    const parts: ReactNode[] = [];
    const re = /@(\d{5,})/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const digits = m[1];
      const label = resolveMentionLabel(digits);
      parts.push(
        <span
          key={`mention-${i++}-${m.index}`}
          className="font-medium text-[hsl(var(--wa-tick-read))]"
          data-testid={`mention-${digits}`}
        >
          @{label}
        </span>,
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : text;
  };
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
    <div className="flex-1 flex min-w-0 bg-[hsl(var(--wa-conversation))]">
      {/* Main chat column (header + search + messages + compose). The
          collapsible info panel sits to its right inside the outer row. */}
      <div className="flex-1 flex flex-col min-w-0">
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
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-[12px] text-[hsl(var(--wa-meta))] truncate">
              {subtitle}
            </p>
            {!isGroup && !chat.isLid && (
              <button
                type="button"
                data-testid="button-copy-phone"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await navigator.clipboard.writeText(subtitle);
                    toast({
                      title: "Nomor disalin",
                      description: subtitle,
                    });
                  } catch {
                    toast({
                      title: "Gagal menyalin",
                      description: "Coba salin manual.",
                      variant: "destructive",
                    });
                  }
                }}
                className="p-0.5 rounded text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0"
                title="Salin nomor"
              >
                <Copy className="w-3 h-3" />
              </button>
            )}
            {chat.isHumanTakeover && (
              <span
                data-testid="badge-manual-mode"
                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[hsl(var(--wa-accent))]/15 text-[hsl(var(--wa-accent))] flex-shrink-0"
                title="Mode manual aktif — AI dinonaktifkan untuk chat ini"
              >
                Manual
              </span>
            )}
          </div>
        </div>

        {/* Header actions */}
        <div className="flex items-center gap-2">
          <button
            data-testid="button-toggle-info-panel"
            type="button"
            onClick={() => setInfoPanelOpen((v) => !v)}
            className={cn(
              "p-2 rounded-full transition-colors",
              infoPanelOpen
                ? "text-foreground bg-white/10"
                : "text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5",
            )}
            title={infoPanelOpen ? "Sembunyikan panel info" : "Tampilkan panel info"}
          >
            {infoPanelOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRightOpen className="w-4 h-4" />
            )}
          </button>

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
                  // Treat two consecutive rows as "same sender" only when
                  // direction matches AND we can positively confirm the
                  // sender is identical. For 1:1 chats both rows have no
                  // sender info, so falling back to direction-only keeps
                  // the existing bubble-continuation behaviour. For groups
                  // we require either the same participant digits or the
                  // same pushName — never collapse two unknown-sender
                  // group bubbles into one stack.
                  const prevDigits = (prev?.senderPhoneDigits ?? null) as string | null;
                  const curDigits = (msg.senderPhoneDigits ?? null) as string | null;
                  const prevName = (prev?.senderName ?? null) as string | null;
                  const curName = (msg.senderName ?? null) as string | null;
                  const bothNoSender =
                    !prevDigits && !curDigits && !prevName && !curName;
                  const sameSenderAsPrev =
                    !!prev &&
                    prev.direction === msg.direction &&
                    (bothNoSender ||
                      (!!curDigits && curDigits === prevDigits) ||
                      (!!curName && curName === prevName));
                  const isCont = prev && prev.direction === msg.direction;
                  const mediaType: string | null = msg.mediaType ?? null;
                  const mediaUrl: string | null = msg.mediaUrl ?? null;
                  // For inbound group messages, show a small sender chip
                  // (avatar + coloured name) above the FIRST bubble of each
                  // consecutive run by the same sender — same as WhatsApp's
                  // group view. Skipped for 1:1 chats (the chat header
                  // already identifies the speaker) and for outbound rows.
                  const showSenderHeader =
                    isGroup &&
                    !isOutbound &&
                    !sameSenderAsPrev &&
                    !!(msg.senderName || msg.senderPhoneDigits);
                  const senderKey: string =
                    msg.senderPhoneDigits || msg.senderName || "";
                  const senderLabel: string =
                    (typeof msg.senderName === "string" && msg.senderName.trim()) ||
                    (msg.senderPhoneDigits ? `+${msg.senderPhoneDigits}` : "Anggota grup");
                  return (
                    <div
                      key={msg.id}
                      data-testid={`message-${msg.id}`}
                      className={cn(
                        "flex mb-0.5",
                        isOutbound ? "justify-end pl-12" : "justify-start pr-12",
                        isCont && sameSenderAsPrev ? "mt-0.5" : "mt-2"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[65%] min-w-[80px] px-2 py-1 text-[14.2px] leading-[19px]",
                          isOutbound ? "wa-bubble-out" : "wa-bubble-in",
                          isCont && sameSenderAsPrev && "wa-bubble-cont"
                        )}
                      >
                        {showSenderHeader && (
                          <div
                            className="flex items-center gap-1.5 mb-0.5"
                            data-testid={`sender-${senderKey}`}
                          >
                            <ChatAvatar
                              name={senderLabel}
                              profilePicUrl={null}
                              size={20}
                            />
                            <span
                              className="text-[12.5px] font-medium truncate"
                              style={{ color: colourForSender(senderKey) }}
                            >
                              {senderLabel}
                            </span>
                          </div>
                        )}
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
                        {mediaType === "sticker" && mediaUrl && (
                          <img
                            src={mediaUrl}
                            alt="Stiker"
                            className="w-32 h-32 object-contain mb-1"
                            data-testid={`sticker-preview-${msg.id}`}
                          />
                        )}
                        {mediaType === "sticker" && !mediaUrl && (
                          <p className="text-xs opacity-70 mb-1">🏷️ Stiker</p>
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
                                  {renderBodyWithMentions(msg.content)}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                        {msg.content && mediaType !== "contact" && (
                          <p className="whitespace-pre-wrap break-words pr-14">
                            {renderBodyWithMentions(msg.content)}
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
            {pastedImage && pastedPreview && (
              <div
                className="mb-2 flex items-start gap-2"
                data-testid="pasted-image-preview"
              >
                <div className="relative">
                  <img
                    src={pastedPreview}
                    alt="Gambar untuk dikirim"
                    className="max-h-32 max-w-[200px] rounded-md object-cover border border-[hsl(var(--wa-divider))]"
                  />
                  <button
                    type="button"
                    data-testid="button-remove-pasted-image"
                    onClick={() => setPastedImage(null)}
                    className="absolute -top-2 -right-2 p-1 rounded-full bg-black/70 text-white hover:bg-black transition-colors"
                    title="Hapus gambar"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <span className="text-[11px] text-[hsl(var(--wa-meta))] mt-1">
                  Tambahkan keterangan lalu tekan kirim.
                </span>
              </div>
            )}
            <textarea
              data-testid="textarea-reply"
              placeholder={pastedImage ? "Tambahkan keterangan…" : "Ketik pesan"}
              value={reply}
              onChange={(e) => {
                // Inline shortcut expansion: every keystroke we expand any
                // "/token" that is now followed by whitespace. The trailing
                // /token (no whitespace yet) is left alone until send, so the
                // user can still finish typing it.
                const next = expandShortcuts(e.target.value, shortcutMap, false);
                setReply(next);
              }}
              onPaste={(e) => {
                // A screenshot / copied image arrives as a file item in the
                // clipboard. Capture it as an attachment instead of letting
                // the browser drop binary noise into the text box.
                if (captureImageFromClipboard(e.clipboardData?.items)) {
                  e.preventDefault();
                }
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
                  handleSend();
                }
              }}
            />
          </div>

          <button
            data-testid="button-send-reply"
            type="button"
            onClick={handleSend}
            disabled={sendReply.isPending || uploading}
            className="p-2 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors disabled:opacity-50"
            title={reply.trim() || pastedImage ? "Kirim" : "Pesan suara"}
          >
            {sendReply.isPending || uploading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : reply.trim() || pastedImage ? (
              <Send className="w-5 h-5 text-[hsl(var(--wa-accent))]" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>

      </div>
      {/* Right-side info panel — Tag, AI Handled/Status, Manual takeover,
          and Assign. Collapsible so the chat takes the full width when
          the user doesn't need these controls. */}
      {infoPanelOpen ? (
        <aside
          className="w-64 flex-shrink-0 border-l border-[hsl(var(--wa-divider))] bg-[hsl(var(--wa-panel-header))] flex flex-col"
          data-testid="chat-info-panel"
        >
          <div className="h-[60px] flex items-center justify-between px-4 border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
            <p className="text-sm font-medium">Info Chat</p>
            <button
              type="button"
              data-testid="button-close-info-panel"
              onClick={() => setInfoPanelOpen(false)}
              className="p-1.5 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors"
              title="Sembunyikan panel"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Tag
              </Label>
              <Select
                value={chat.tag}
                onValueChange={(val) =>
                  updateChat.mutate({ id: chatId, data: { tag: val as any } })
                }
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
                onValueChange={(val) =>
                  updateChat.mutate({ id: chatId, data: { status: val as any } })
                }
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
                  onCheckedChange={(checked) =>
                    takeover.mutate({ id: chatId, data: { takeover: checked } })
                  }
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
                    assignMut.mutate({
                      id: chatId,
                      data: { userId: v === "__unassigned" ? null : Number(v) },
                    })
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
                    {agentsData?.agents
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
        </aside>
      ) : null}

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
