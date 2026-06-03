import { useState, useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
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
  useSetMessageStar,
  getGetStarredMessagesQueryKey,
  useDeleteMessageForMe,
  useRevokeMessage,
  useReactMessage,
  useSetMessagePin,
  getLinkPreview,
  useListChats,
  useForwardMessage,
  useGetGroupInfo,
  getGetGroupInfoQueryKey,
  getChatHistory,
  type GroupParticipant,
  type LinkPreview as LinkPreviewData,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatAvatar } from "@/components/ChatAvatar";
import { ChatInfoSidebar } from "@/components/ChatInfoSidebar";
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
  DropdownMenuSeparator,
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
  Star,
  Trash2,
  Share2,
  Reply,
  Pin,
  PinOff,
  CheckSquare,
  MessageCircle,
  CornerUpLeft,
} from "lucide-react";
import { cn, resolveImageSrc } from "@/lib/utils";
import { format, isToday, isYesterday, isThisYear } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import { useShortcutMap, expandShortcuts } from "@/lib/shortcuts";

type MediaKind = "image" | "video" | "document";

// Digits of a participant JID's local part ("628…@s.whatsapp.net" -> "628…",
// "9988@lid" -> "9988"). This is exactly the "@<localpart>" token WhatsApp
// expects in the body so the mention links to the participant.
function jidLocalDigits(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? "";
}

// The label shown for a participant in the @picker and inserted into the
// compose box: their name, else real phone, else the JID's digits.
function participantLabel(p: GroupParticipant): string {
  const name = p.name?.trim();
  if (name) return name;
  if (p.phone) return p.phone;
  return jidLocalDigits(p.jid) || p.jid;
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return "Hari ini";
  if (isYesterday(d)) return "Kemarin";
  if (isThisYear(d)) return format(d, "d MMMM", { locale: idLocale });
  return format(d, "d MMMM yyyy", { locale: idLocale });
}

// Quick-react emoji palette shown in the per-message reaction bar.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// A short human label for a media-only message, used when it is quoted in a
// reply bar (where there's no text body to show).
function mediaPlaceholder(msg: any): string {
  switch (msg?.mediaType) {
    case "image":
      return "📷 Foto";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎙️ Pesan suara";
    case "sticker":
      return "🏷️ Stiker";
    case "document":
      return `📄 ${msg.mediaFilename ?? "Dokumen"}`;
    case "contact":
      return "👤 Kontak";
    default:
      return "Pesan";
  }
}

// Matches http(s) URLs and bare "www." / domain-style links so we can render
// them as clickable anchors. Kept permissive but anchored on a scheme or a
// "www."/domain boundary so we don't accidentally linkify plain words.
const URL_RE =
  /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}'"]|[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|co|id|ai|app|dev|me|info|biz|store|xyz|link|gg|tv)(?:\/[^\s<]*)?)/gi;

// Normalize a matched link into an href the browser can open. Bare domains /
// "www." links get an https:// scheme so they open as absolute URLs.
function hrefForLink(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// Return the first link found in a body, or null. Used to decide whether to
// render a link-preview card under the bubble.
function firstLink(text: string): string | null {
  if (!text) return null;
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}

// A WhatsApp-style link-preview card. Fetches OpenGraph metadata for the URL
// from the server (SSRF-guarded) and renders a clickable thumbnail + title +
// description. Renders nothing until/unless useful metadata is available.
function LinkPreviewCard({ url, isOutbound }: { url: string; isOutbound: boolean }) {
  const [data, setData] = useState<LinkPreviewData | null>(null);
  // Normalize before fetching: linkified text can include scheme-less links
  // (e.g. "www.example.com"); the server parses with `new URL()` and rejects
  // those, so send the canonical href the card itself links to.
  const fetchUrl = hrefForLink(url);
  useEffect(() => {
    let alive = true;
    setData(null);
    getLinkPreview({ url: fetchUrl })
      .then((res) => {
        if (alive) setData(res);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [fetchUrl]);
  if (!data || (!data.title && !data.description && !data.image)) return null;
  return (
    <a
      href={hrefForLink(url)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview-card"
      className={cn(
        "block mb-1 overflow-hidden rounded-md border border-black/10 no-underline",
        isOutbound ? "bg-black/10" : "bg-black/20",
      )}
    >
      {data.image && (
        <img
          src={data.image}
          alt={data.title ?? "preview"}
          className="w-full max-h-40 object-cover"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <div className="px-2.5 py-1.5">
        {data.siteName && (
          <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--wa-meta))] truncate">
            {data.siteName}
          </p>
        )}
        {data.title && (
          <p className="text-[12.5px] font-medium text-foreground line-clamp-2">
            {data.title}
          </p>
        )}
        {data.description && (
          <p className="text-[11.5px] text-[hsl(var(--wa-meta))] line-clamp-2">
            {data.description}
          </p>
        )}
      </div>
    </a>
  );
}

export default function ConversationPane({ chatId }: { chatId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

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
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  // @mention picker (group chats only). `query` is the text typed after the
  // active "@"; `start` is the index of that "@" in the textarea value so we
  // can replace the token on select. `index` is the keyboard-highlighted row.
  const [mention, setMention] = useState<
    { start: number; query: string; index: number } | null
  >(null);
  // Tracks mentions the operator inserted via the picker: the visible
  // "@<label>" token mapped to the participant's JID + digits. On send we swap
  // each surviving label token for "@<digits>" and ship the JIDs to Baileys.
  const [pickedMentions, setPickedMentions] = useState<
    { label: string; jid: string; digits: string }[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Scroll container — used to restore scroll position when we prepend older
  // history so the viewport doesn't jump after a "load older" fetch.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Older messages paged in above the recent window served by useGetChat.
  // Kept oldest-first; merged with chat.messages and de-duped before render.
  const [olderMessages, setOlderMessages] = useState<any[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // True once a history page reports there's nothing older left to fetch.
  const [historyExhausted, setHistoryExhausted] = useState(false);
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
  // Drop all transient per-message UI state when switching chats so a reply
  // quote, open reaction bar, or select-mode selection can never leak into a
  // different conversation (a stale quote would otherwise carry a foreign
  // quotedMessageId the server silently ignores).
  useEffect(() => {
    setReplyTo(null);
    setReactionTarget(null);
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [chatId]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [sendingContact, setSendingContact] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<number | null>(null);
  const [forwardSource, setForwardSource] = useState<number | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");
  const [forwardSelected, setForwardSelected] = useState<Set<number>>(
    () => new Set()
  );
  // Active "reply to" target shown as a quoted bar above the composer. Sent
  // along as quotedMessageId so the outbound message threads under the original.
  const [replyTo, setReplyTo] = useState<
    { id: number; sender: string; content: string } | null
  >(null);
  // Message whose emoji reaction bar is currently open (the small pill row).
  const [reactionTarget, setReactionTarget] = useState<number | null>(null);
  // Multi-select mode for bulk forward/delete (WhatsApp "Pilih pesan").
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  // Briefly highlights a bubble after we scroll to it (e.g. tapping a quote).
  const [highlightId, setHighlightId] = useState<number | null>(null);
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

  const setStarMut = useSetMessageStar({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({
          queryKey: getGetStarredMessagesQueryKey(chatId),
        });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menandai pesan",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  function toggleStar(messageId: number, current: boolean) {
    setStarMut.mutate({
      id: chatId,
      messageId,
      data: { starred: !current },
    });
  }

  const reactMut = useReactMessage({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menambah reaksi",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  function reactTo(messageId: number, emoji: string) {
    setReactionTarget(null);
    reactMut.mutate({ id: chatId, messageId, data: { emoji } });
  }

  const pinMut = useSetMessagePin({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menyematkan pesan",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  function togglePin(messageId: number, pinned: boolean) {
    pinMut.mutate({ id: chatId, messageId, data: { pinned } });
  }

  // Jump to a message bubble already rendered in the list and flash it. Used
  // when tapping a quoted-reply bar. No-op if the original isn't in the window.
  function scrollToMessage(messageId: number) {
    const el = document.querySelector(
      `[data-testid="message-${messageId}"]`,
    );
    if (!el) {
      toast({ title: "Pesan asli tidak ada di tampilan ini." });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    window.setTimeout(() => setHighlightId(null), 1600);
  }

  // Copy a message body to the clipboard.
  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Pesan disalin." });
    } catch {
      toast({
        title: "Gagal menyalin",
        description: "Coba salin manual.",
        variant: "destructive",
      });
    }
  }

  // Begin replying to a message: stash the quoted snippet and focus the box.
  function startReply(msg: any) {
    const sender =
      msg.direction === "outbound"
        ? "Anda"
        : (typeof msg.senderName === "string" && msg.senderName.trim()) ||
          displayName;
    setReplyTo({
      id: msg.id,
      sender,
      content:
        (typeof msg.content === "string" && msg.content.trim()) ||
        mediaPlaceholder(msg),
    });
    requestAnimationFrame(() => replyRef.current?.focus());
  }

  // Toggle a message in multi-select mode.
  function toggleSelected(messageId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  // Navigate to the 1:1 chat for a group participant ("Kirim pesan" / "Balas
  // pribadi"). Resolves an existing chat by phone digits; if none exists we
  // tell the user rather than silently failing.
  function openPrivateChat(digits: string | null | undefined) {
    if (!digits) {
      toast({ title: "Nomor anggota tidak diketahui." });
      return;
    }
    const match = (allChats ?? []).find((c: any) => {
      const phone = typeof c.phoneNumber === "string" ? c.phoneNumber : "";
      return (
        !phone.endsWith("@g.us") && phone.replace(/\D/g, "").endsWith(digits)
      );
    });
    if (match) {
      navigate(`/chats/${match.id}`);
    } else {
      toast({
        title: "Chat pribadi belum ada",
        description: "Belum ada percakapan langsung dengan anggota ini.",
      });
    }
  }

  function invalidateAfterDelete() {
    qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
    qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetStarredMessagesQueryKey(chatId) });
  }

  const deleteForMeMut = useDeleteMessageForMe({
    mutation: {
      onSuccess: () => {
        invalidateAfterDelete();
        toast({ title: "Pesan dihapus untuk Anda." });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menghapus pesan",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  const revokeMut = useRevokeMessage({
    mutation: {
      onSuccess: () => {
        invalidateAfterDelete();
        toast({ title: "Pesan dihapus untuk semua orang." });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menghapus untuk semua orang",
          description: err?.message ?? "",
          variant: "destructive",
        }),
      onSettled: () => setRevokeTarget(null),
    },
  });

  function deleteForMe(messageId: number) {
    deleteForMeMut.mutate({ id: chatId, messageId });
  }

  // Chat list for the forward picker. Only fetched while the dialog is open
  // to avoid an extra request on every conversation open.
  const { data: forwardChats, isLoading: forwardChatsLoading } = useListChats(
    undefined,
    {
      query: {
        queryKey: getListChatsQueryKey(),
        enabled: forwardSource != null,
      },
    }
  );

  // Chat list used to resolve a group member's 1:1 chat for "Kirim pesan" /
  // "Balas pribadi". Reads from the shared list cache (populated by the chat
  // list page); kept fresh enough without polling.
  const { data: allChats } = useListChats(undefined, {
    query: {
      queryKey: getListChatsQueryKey(),
      staleTime: 30_000,
    },
  });

  const forwardMut = useForwardMessage({
    mutation: {
      onSuccess: (data) => {
        if (data.failed > 0) {
          toast({
            title: `Diteruskan ke ${data.sent} chat`,
            description: `${data.failed} gagal diteruskan.`,
            variant: data.sent > 0 ? "default" : "destructive",
          });
        } else {
          toast({ title: `Pesan diteruskan ke ${data.sent} chat.` });
        }
        setForwardSource(null);
        setForwardSelected(new Set());
        setForwardSearch("");
      },
      onError: (err: any) =>
        toast({
          title: "Gagal meneruskan pesan",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  function toggleForwardTarget(targetId: number) {
    setForwardSelected((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  }

  function submitForward() {
    if (forwardSource == null || forwardSelected.size === 0) return;
    forwardMut.mutate({
      id: chatId,
      messageId: forwardSource,
      data: { targetChatIds: Array.from(forwardSelected) },
    });
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

  // Swap every surviving "@<label>" token the operator inserted via the picker
  // back to the "@<digits>" form WhatsApp needs, and collect the JIDs to
  // notify. Tokens the user deleted are silently dropped (no stale mention).
  //
  // We walk the text left-to-right with a single boundary-anchored regex
  // instead of a naive substring replace, which fixes two bugs:
  //   - boundaries: "@Adi" must not match inside "@Adianto" (the token must end
  //     at whitespace, end-of-text, or a non-word char).
  //   - collisions: two members with the SAME display label are each consumed
  //     once, in order of appearance, so they map to distinct JIDs instead of
  //     both collapsing onto the first pick's digits.
  function applyPickedMentions(text: string): { text: string; jids: string[] } {
    // Longest labels first so an alternation prefers "@Budi Santoso" over a
    // bare "@Budi" when both are picked.
    const sorted = [...pickedMentions].sort(
      (a, b) => b.label.length - a.label.length,
    );
    if (sorted.length === 0) return { text, jids: [] };
    const remaining = sorted.map((m) => ({ ...m, used: false }));
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alternation = sorted.map((m) => escapeRe(m.label)).join("|");
    // The token must follow start/whitespace and be followed by a word
    // boundary so we never rewrite a substring of a longer word.
    const re = new RegExp(`(^|\\s)@(${alternation})(?=$|\\s|[^\\w])`, "g");
    const jids: string[] = [];
    const out = text.replace(re, (full, pre: string, label: string) => {
      const pick = remaining.find((m) => !m.used && m.label === label);
      if (!pick) return full; // every pick of this label already consumed
      pick.used = true;
      if (!jids.includes(pick.jid)) jids.push(pick.jid);
      return `${pre}@${pick.digits}`;
    });
    return { text: out, jids };
  }

  function handleSend() {
    // Guard the keyboard path too (the button is disabled, Enter isn't) so an
    // in-flight upload/send can't be duplicated or run concurrently.
    if (uploading || sendReply.isPending) return;
    if (pastedImage) {
      // Media captions can't carry WhatsApp mention metadata, but we still
      // convert the visible "@name" tokens to "@digits" so the caption renders
      // consistently with how a sent mention looks.
      const caption = applyPickedMentions(
        expandShortcuts(reply, shortcutMap, true),
      ).text;
      const img = pastedImage;
      setPastedImage(null);
      void uploadMedia(img, caption);
      return;
    }
    const { text, jids } = applyPickedMentions(
      expandShortcuts(reply, shortcutMap, true),
    );
    const finalText = text.trim();
    if (finalText) {
      const quotedMessageId = replyTo?.id;
      sendReply.mutate({
        id: chatId,
        data: {
          content: finalText,
          ...(jids.length ? { mentions: jids } : {}),
          ...(quotedMessageId ? { quotedMessageId } : {}),
        },
      });
    }
  }

  // Detect whether the caret sits inside an "@token" so we can open the picker.
  // The "@" must start the text or follow whitespace, and the token must not
  // yet contain a space (the token ends at the first space).
  function detectMention(value: string, caret: number) {
    if (!isGroupChat) {
      setMention(null);
      return;
    }
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) {
      setMention(null);
      return;
    }
    const before = at === 0 ? " " : upToCaret[at - 1];
    if (!/\s/.test(before)) {
      setMention(null);
      return;
    }
    const query = upToCaret.slice(at + 1);
    if (/\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ start: at, query, index: 0 });
  }

  // Replace the active "@query" token with the chosen participant's label and
  // remember the mapping so handleSend can turn it back into "@digits".
  function insertMention(p: GroupParticipant) {
    if (!mention) return;
    const label = participantLabel(p);
    const digits = jidLocalDigits(p.jid);
    const token = `@${label} `;
    const before = reply.slice(0, mention.start);
    const after = reply.slice(mention.start + 1 + mention.query.length);
    const nextText = before + token + after;
    setReply(nextText);
    setPickedMentions((prev) =>
      prev.some((m) => m.jid === p.jid && m.label === label)
        ? prev
        : [...prev, { label, jid: p.jid, digits }],
    );
    setMention(null);
    const caretPos = before.length + token.length;
    requestAnimationFrame(() => {
      const el = replyRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caretPos, caretPos);
      }
    });
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
        setPickedMentions([]);
        setMention(null);
        setReplyTo(null);
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  // Live group roster for the @mention picker. Only fetched for group chats —
  // it hits WhatsApp's groupMetadata on the server, so we keep it cheap with a
  // long staleTime and no polling.
  const isGroupChat = !!chat && chat.phoneNumber.endsWith("@g.us");
  const { data: groupInfo } = useGetGroupInfo(chatId, {
    query: {
      queryKey: getGetGroupInfoQueryKey(chatId),
      enabled: !!chatId && isGroupChat,
      staleTime: 60_000,
    },
  });
  const groupParticipants: GroupParticipant[] = groupInfo?.participants ?? [];

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

  // Switching chats discards any history we paged in for the previous one —
  // the recent window from useGetChat is the fresh baseline for the new chat.
  useEffect(() => {
    setOlderMessages([]);
    setLoadingOlder(false);
    setHistoryExhausted(false);
  }, [chatId]);

  // Fetch the next page of older messages above the current oldest one and
  // prepend it, restoring scroll position so the viewport stays put instead of
  // jumping to the top after the DOM grows.
  async function loadOlderMessages() {
    if (!chatId || loadingOlder || historyExhausted) return;
    const oldest = combinedMessages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    const container = scrollContainerRef.current;
    const prevHeight = container?.scrollHeight ?? 0;
    const prevTop = container?.scrollTop ?? 0;
    try {
      const page = await getChatHistory({ chatId, before: oldest.id });
      setOlderMessages((prev) => [...page.messages, ...prev]);
      if (!page.hasMore) setHistoryExhausted(true);
      // Restore scroll so the first previously-visible message stays in place.
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch (err: any) {
      toast({
        title: "Gagal memuat pesan lama",
        description: err?.message ?? "",
        variant: "destructive",
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  // Autoscroll to the most recent message whenever a NEW message arrives — the
  // canonical WhatsApp UX (you always land at the bottom of the thread). Keyed
  // on the newest message's id (not the count): the recent window is capped at
  // 200, so once a busy chat hits the cap the length stops changing even as new
  // messages stream in. Paging in older history doesn't change this id, so it
  // correctly does NOT yank the viewport to the bottom.
  const newestMessageId =
    chat?.messages && chat.messages.length > 0
      ? chat.messages[chat.messages.length - 1].id
      : undefined;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [newestMessageId, chat?.id]);

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

  // The recent window from useGetChat plus any older history we've paged in.
  // De-dupe by id (the recent window can overlap a freshly-fetched page) and
  // sort chronologically by (createdAt, id) — the same total order the server
  // pages by — so bubbles render in a stable sequence.
  const combinedMessages = (() => {
    const byId = new Map<number, any>();
    for (const m of olderMessages) byId.set(m.id, m);
    for (const m of chat.messages as any[]) byId.set(m.id, m);
    return Array.from(byId.values()).sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return ta === tb ? a.id - b.id : ta - tb;
    });
  })();

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
  for (const m of combinedMessages as any[]) {
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

  // Names from the live group roster (groupMetadata + contacts), keyed by the
  // digits that appear inside an "@<digits>" token — both the JID local part
  // and the resolved real phone — so a mention we just sent renders as a name
  // even before that member has a message in this chat's history.
  const rosterLabelByDigits = new Map<string, string>();
  for (const p of groupParticipants) {
    const label = participantLabel(p);
    const local = jidLocalDigits(p.jid);
    if (local) rosterLabelByDigits.set(local, label);
    if (p.phone) rosterLabelByDigits.set(p.phone, label);
  }

  // Resolve a raw mention digits string to the best display label we have:
  // first the group-local participant we collected from history, then the live
  // group roster, else fall back to the digits as-is.
  const resolveMentionLabel = (digits: string): string => {
    const fromHistory = participantsByPhone.get(digits);
    if (fromHistory) return fromHistory;
    const fromRoster = rosterLabelByDigits.get(digits);
    if (fromRoster) return fromRoster;
    return digits;
  };

  // Participants matching the active "@query" (by name, phone, or digits),
  // capped so the popover stays compact.
  const mentionQuery = (mention?.query ?? "").toLowerCase();
  const mentionCandidates = mention
    ? groupParticipants
        .filter((p) => {
          if (!mentionQuery) return true;
          const hay = `${p.name ?? ""} ${p.phone ?? ""} ${jidLocalDigits(p.jid)}`.toLowerCase();
          return hay.includes(mentionQuery);
        })
        .slice(0, 8)
    : [];
  const mentionOpen = !!mention && mentionCandidates.length > 0;
  const mentionActiveIndex = mention
    ? Math.min(mention.index, mentionCandidates.length - 1)
    : 0;

  // Render a message body, swapping every "@<digits>" token for the
  // resolved nickname (highlighted as a chip-like span). Splits the text
  // on the mention regex so React can interleave plain strings with
  // styled <span> elements without dangerouslySetInnerHTML.
  // Split a plain-text run into text + clickable <a> link nodes. Links open in
  // a new tab (the device browser) and are isolated from app navigation.
  const linkify = (text: string, keyBase: string): ReactNode[] => {
    const out: ReactNode[] = [];
    URL_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const raw = m[0];
      out.push(
        <a
          key={`${keyBase}-link-${i++}-${m.index}`}
          href={hrefForLink(raw)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="underline break-all text-[hsl(var(--wa-tick-read))]"
          data-testid="message-link"
        >
          {raw}
        </a>,
      );
      last = m.index + raw.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const renderBodyWithMentions = (text: string): ReactNode => {
    const parts: ReactNode[] = [];
    const re = /@(\d{5,})/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last)
        parts.push(...linkify(text.slice(last, m.index), `seg-${i}`));
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
    if (last < text.length) parts.push(...linkify(text.slice(last), "seg-tail"));
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
    ? combinedMessages.filter((m: any) =>
        typeof m.content === "string" &&
        m.content.toLowerCase().includes(trimmedQuery)
      )
    : combinedMessages;

  // Messages the operator has pinned locally, newest last. Surfaced in a small
  // bar above the thread (WhatsApp's pinned-message strip).
  const pinnedMessages = combinedMessages.filter((m: any) => m.pinnedAt);
  const lastPinned = pinnedMessages[pinnedMessages.length - 1];

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

      {/* Select-mode toolbar (WhatsApp "Pilih pesan"): count + bulk delete. */}
      {selectMode && (
        <div
          className="flex items-center gap-3 px-4 h-12 bg-[hsl(var(--wa-panel-header))] border-b border-[hsl(var(--wa-divider))] flex-shrink-0"
          data-testid="select-toolbar"
        >
          <button
            type="button"
            onClick={exitSelectMode}
            className="p-1.5 rounded-full hover:bg-white/5 text-[hsl(var(--wa-meta))] hover:text-foreground transition-colors"
            title="Batal"
            data-testid="button-exit-select"
          >
            <X className="w-4 h-4" />
          </button>
          <span className="text-[13px] text-foreground flex-1">
            {selectedIds.size} dipilih
          </span>
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => {
              const ids = Array.from(selectedIds);
              ids.forEach((mid) => deleteForMe(mid));
              exitSelectMode();
            }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[13px] text-red-500 hover:bg-white/5 disabled:opacity-40 transition-colors"
            data-testid="button-bulk-delete"
          >
            <Trash2 className="w-4 h-4" />
            Hapus
          </button>
        </div>
      )}

      {/* Pinned-message strip: jump to the most recently pinned message. */}
      {!selectMode && lastPinned && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 bg-[hsl(var(--wa-panel-header))] border-b border-[hsl(var(--wa-divider))] flex-shrink-0"
          data-testid="pinned-bar"
        >
          <Pin className="w-3.5 h-3.5 text-[hsl(var(--wa-accent))] shrink-0" />
          <button
            type="button"
            onClick={() => scrollToMessage(lastPinned.id)}
            className="min-w-0 flex-1 text-left"
            data-testid="button-jump-pinned"
          >
            <span className="text-[12px] text-[hsl(var(--wa-meta))] truncate block">
              {pinnedMessages.length} pesan disematkan ·{" "}
              {lastPinned.content || mediaPlaceholder(lastPinned)}
            </span>
          </button>
        </div>
      )}

      {/* Messages on doodle background */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto wa-scroll wa-doodle-bg px-[8%] py-4"
      >
        {trimmedQuery && visibleMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-[hsl(var(--wa-meta))]">
              <p className="text-sm">Tidak ada pesan yang cocok</p>
            </div>
          </div>
        ) : combinedMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-[hsl(var(--wa-meta))]">
              <p className="text-sm">Belum ada pesan</p>
            </div>
          </div>
        ) : (
          <>
            {/* Lazy-load older history above the recent window. Hidden while an
                in-chat search is active (search only scans loaded messages) and
                once we've reached the start of the conversation. */}
            {!trimmedQuery && chat.hasMoreMessages && !historyExhausted && (
              <div className="flex justify-center my-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={loadOlderMessages}
                  disabled={loadingOlder}
                  data-testid="button-load-older"
                  className="text-[12px]"
                >
                  {loadingOlder ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    "Muat pesan lama"
                  )}
                </Button>
              </div>
            )}
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
                      onClick={
                        selectMode ? () => toggleSelected(msg.id) : undefined
                      }
                      className={cn(
                        "group flex mb-0.5 items-center gap-2",
                        selectMode && "cursor-pointer",
                        isOutbound ? "justify-end pl-12" : "justify-start pr-12",
                        isCont && sameSenderAsPrev ? "mt-0.5" : "mt-2"
                      )}
                    >
                      {selectMode && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(msg.id)}
                          readOnly
                          data-testid={`select-message-${msg.id}`}
                          className="w-4 h-4 accent-[hsl(var(--wa-accent))] flex-shrink-0"
                        />
                      )}
                      <div
                        className={cn(
                          "relative max-w-[65%] min-w-[80px] px-2 py-1 text-[14.2px] leading-[19px]",
                          isOutbound ? "wa-bubble-out" : "wa-bubble-in",
                          isCont && sameSenderAsPrev && "wa-bubble-cont",
                          highlightId === msg.id &&
                            "ring-2 ring-[hsl(var(--wa-accent))]"
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
                        {msg.isForwarded && (
                          <div
                            className="flex items-center gap-1 mb-0.5 text-[12px] italic text-[hsl(var(--wa-meta))]"
                            data-testid={`forwarded-badge-${msg.id}`}
                          >
                            <Share2 className="w-3 h-3" />
                            <span>
                              {(msg.forwardingScore ?? 0) >= 4
                                ? "Diteruskan berkali-kali"
                                : "Diteruskan"}
                            </span>
                          </div>
                        )}
                        {msg.quotedContent && (
                          <button
                            type="button"
                            onClick={() =>
                              msg.quotedMessageId &&
                              scrollToMessage(msg.quotedMessageId)
                            }
                            data-testid={`quoted-${msg.id}`}
                            className="flex w-full flex-col items-start text-left mb-1 pl-2 pr-2 py-1 rounded bg-black/20 border-l-[3px] border-[hsl(var(--wa-accent))]"
                          >
                            <span className="text-[12px] font-medium text-[hsl(var(--wa-accent))] truncate max-w-full">
                              {msg.quotedSender || "Pesan"}
                            </span>
                            <span className="text-[12px] text-[hsl(var(--wa-meta))] line-clamp-2 break-words max-w-full">
                              {msg.quotedContent}
                            </span>
                          </button>
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
                        {msg.content &&
                          mediaType !== "contact" &&
                          firstLink(msg.content) && (
                            <LinkPreviewCard
                              url={firstLink(msg.content)!}
                              isOutbound={isOutbound}
                            />
                          )}
                        {msg.content && mediaType !== "contact" && (
                          <p className="whitespace-pre-wrap break-words pr-14">
                            {renderBodyWithMentions(msg.content)}
                          </p>
                        )}
                        {Array.isArray(msg.reactions) &&
                          msg.reactions.length > 0 && (
                            <div
                              className="flex flex-wrap gap-0.5 mt-0.5"
                              data-testid={`reactions-${msg.id}`}
                            >
                              {msg.reactions.map((r: any, ri: number) => (
                                <span
                                  key={ri}
                                  className="text-[12px] bg-black/25 rounded-full px-1.5 py-0.5 leading-none"
                                >
                                  {r.emoji}
                                </span>
                              ))}
                            </div>
                          )}
                        <div className="flex items-center justify-end gap-1 -mt-3 -mb-0.5 float-right pl-2">
                          <button
                            type="button"
                            onClick={() => toggleStar(msg.id, !!msg.isStarred)}
                            data-testid={`button-star-${msg.id}`}
                            className={cn(
                              "p-0.5 rounded-full hover:bg-black/10 transition-colors",
                              msg.isStarred
                                ? "text-amber-400"
                                : "text-[hsl(var(--wa-meta))] opacity-0 group-hover:opacity-100"
                            )}
                            title={
                              msg.isStarred
                                ? "Hapus dari berbintang"
                                : "Tandai berbintang"
                            }
                          >
                            <Star
                              className="w-3 h-3"
                              fill={msg.isStarred ? "currentColor" : "none"}
                            />
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                data-testid={`button-msg-menu-${msg.id}`}
                                title="Opsi pesan"
                                className="p-0.5 rounded-full hover:bg-black/10 transition-colors text-[hsl(var(--wa-meta))] opacity-0 group-hover:opacity-100"
                              >
                                <MoreVertical className="w-3 h-3" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              side="top"
                              className="w-56"
                            >
                              <DropdownMenuItem
                                onClick={() => startReply(msg)}
                                data-testid={`menu-reply-${msg.id}`}
                              >
                                <Reply className="w-3.5 h-3.5 mr-2" />
                                Balas
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setReactionTarget((cur) =>
                                    cur === msg.id ? null : msg.id,
                                  )
                                }
                                data-testid={`menu-react-${msg.id}`}
                              >
                                <Smile className="w-3.5 h-3.5 mr-2" />
                                Reaksi
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  toggleStar(msg.id, !!msg.isStarred)
                                }
                                data-testid={`menu-star-${msg.id}`}
                              >
                                <Star className="w-3.5 h-3.5 mr-2" />
                                {msg.isStarred ? "Hapus bintang" : "Bintang"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => togglePin(msg.id, !msg.pinnedAt)}
                                data-testid={`menu-pin-${msg.id}`}
                              >
                                {msg.pinnedAt ? (
                                  <PinOff className="w-3.5 h-3.5 mr-2" />
                                ) : (
                                  <Pin className="w-3.5 h-3.5 mr-2" />
                                )}
                                {msg.pinnedAt ? "Lepas sematan" : "Sematkan"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setForwardSelected(new Set());
                                  setForwardSearch("");
                                  setForwardSource(msg.id);
                                }}
                                data-testid={`menu-forward-${msg.id}`}
                              >
                                <Share2 className="w-3.5 h-3.5 mr-2" />
                                Teruskan
                              </DropdownMenuItem>
                              {msg.content && (
                                <DropdownMenuItem
                                  onClick={() => copyMessage(msg.content)}
                                  data-testid={`menu-copy-${msg.id}`}
                                >
                                  <Copy className="w-3.5 h-3.5 mr-2" />
                                  Salin
                                </DropdownMenuItem>
                              )}
                              {isGroup && !isOutbound && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() =>
                                      openPrivateChat(msg.senderPhoneDigits)
                                    }
                                    data-testid={`menu-reply-privately-${msg.id}`}
                                  >
                                    <CornerUpLeft className="w-3.5 h-3.5 mr-2" />
                                    Balas pribadi
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      openPrivateChat(msg.senderPhoneDigits)
                                    }
                                    data-testid={`menu-message-${msg.id}`}
                                  >
                                    <MessageCircle className="w-3.5 h-3.5 mr-2" />
                                    <span className="truncate">
                                      Kirim pesan ke {senderLabel}
                                    </span>
                                  </DropdownMenuItem>
                                </>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => deleteForMe(msg.id)}
                                data-testid={`menu-delete-for-me-${msg.id}`}
                              >
                                <Trash2 className="w-3.5 h-3.5 mr-2" />
                                Hapus untuk saya
                              </DropdownMenuItem>
                              {isOutbound && (
                                <DropdownMenuItem
                                  onClick={() => setRevokeTarget(msg.id)}
                                  className="text-red-600 focus:text-red-600"
                                  data-testid={`menu-delete-for-everyone-${msg.id}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5 mr-2" />
                                  Hapus untuk semua orang
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectMode(true);
                                  setSelectedIds(new Set([msg.id]));
                                }}
                                data-testid={`menu-select-${msg.id}`}
                              >
                                <CheckSquare className="w-3.5 h-3.5 mr-2" />
                                Pilih pesan
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
                        {reactionTarget === msg.id && (
                          <div
                            className="absolute z-30 -top-8 right-1 flex gap-1 rounded-full bg-[hsl(var(--wa-panel-header))] border border-[hsl(var(--wa-divider))] px-2 py-1 shadow-lg"
                            data-testid={`reaction-bar-${msg.id}`}
                          >
                            {QUICK_EMOJIS.map((e) => (
                              <button
                                key={e}
                                type="button"
                                onClick={() => reactTo(msg.id, e)}
                                className="text-[18px] leading-none hover:scale-125 transition-transform"
                                data-testid={`react-${msg.id}-${e}`}
                              >
                                {e}
                              </button>
                            ))}
                          </div>
                        )}
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

          <div className="relative flex-1 bg-[hsl(var(--wa-panel))] rounded-lg px-3 py-2">
            {mentionOpen && (
              <div
                data-testid="mention-popover"
                className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto rounded-lg border border-[hsl(var(--wa-divider))] bg-[hsl(var(--wa-panel-header))] shadow-lg z-20 py-1"
              >
                {mentionCandidates.map((p, i) => {
                  const label = participantLabel(p);
                  return (
                    <button
                      key={p.jid}
                      type="button"
                      data-testid={`mention-option-${jidLocalDigits(p.jid)}`}
                      onMouseDown={(e) => {
                        // Keep focus in the textarea; mousedown fires before
                        // the textarea blur so the caret restore works.
                        e.preventDefault();
                        insertMention(p);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                        i === mentionActiveIndex
                          ? "bg-white/10"
                          : "hover:bg-white/5"
                      }`}
                    >
                      <ChatAvatar name={label} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-foreground">
                          {label}
                          {p.isAdmin && (
                            <span className="ml-1 text-[10px] text-[hsl(var(--wa-meta))]">
                              admin
                            </span>
                          )}
                        </div>
                        {p.phone && p.phone !== label && (
                          <div className="truncate text-[11px] text-[hsl(var(--wa-meta))]">
                            {p.phone}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {replyTo && (
              <div
                className="mb-2 flex items-stretch gap-2 rounded-md bg-[hsl(var(--wa-panel-header))] border-l-[3px] border-[hsl(var(--wa-accent))] pl-2 pr-1 py-1"
                data-testid="reply-compose-bar"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-[hsl(var(--wa-accent))] truncate">
                    {replyTo.sender}
                  </div>
                  <div className="text-[12px] text-[hsl(var(--wa-meta))] truncate">
                    {replyTo.content}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="button-cancel-reply"
                  onClick={() => setReplyTo(null)}
                  className="self-start p-1 rounded-full hover:bg-black/10 transition-colors text-[hsl(var(--wa-meta))]"
                  title="Batal balas"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
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
              ref={replyRef}
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
                // Open/refresh the @mention picker for the token under the
                // caret. When expansion changed the text, the event caret no
                // longer matches `next`, so fall back to its end.
                const caret =
                  next === e.target.value ? e.target.selectionStart : next.length;
                detectMention(next, caret);
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
                // While the @mention picker is open, arrows move the
                // highlight, Enter/Tab pick the highlighted member, and Escape
                // dismisses it — none of these should send the message.
                if (mentionOpen && mention) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMention({
                      ...mention,
                      index: (mentionActiveIndex + 1) % mentionCandidates.length,
                    });
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMention({
                      ...mention,
                      index:
                        (mentionActiveIndex - 1 + mentionCandidates.length) %
                        mentionCandidates.length,
                    });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    insertMention(mentionCandidates[mentionActiveIndex]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
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
      {/* Right-side info panel — tabbed (Info / Shortcut / Produk / Order)
          with maximize/minimize. Collapsible so the chat takes the full
          width when the user doesn't need these controls. */}
      {infoPanelOpen ? (
        <ChatInfoSidebar
          chatId={chatId}
          chat={chat}
          canAssign={canAssign}
          agents={agentsData?.agents ?? []}
          onClose={() => setInfoPanelOpen(false)}
          onUpdate={(data) =>
            updateChat.mutate({ id: chatId, data: data as any })
          }
          onTakeover={(checked) =>
            takeover.mutate({ id: chatId, data: { takeover: checked } })
          }
          onAssign={(userId) =>
            assignMut.mutate({ id: chatId, data: { userId } })
          }
        />
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

      <Dialog
        open={revokeTarget != null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <DialogContent data-testid="dialog-revoke-confirm">
          <DialogHeader>
            <DialogTitle>Hapus untuk semua orang?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Pesan ini akan ditarik dari WhatsApp/Telegram sehingga penerima juga
            tidak bisa melihatnya lagi. Tindakan ini tidak bisa dibatalkan, dan
            hanya berhasil jika pesan belum terlalu lama.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={revokeMut.isPending}
              data-testid="button-revoke-cancel"
            >
              Batal
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                revokeTarget != null &&
                revokeMut.mutate({ id: chatId, messageId: revokeTarget })
              }
              disabled={revokeMut.isPending}
              data-testid="button-revoke-confirm"
            >
              {revokeMut.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Hapus untuk semua
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={forwardSource != null}
        onOpenChange={(open) => {
          if (!open) {
            setForwardSource(null);
            setForwardSelected(new Set());
            setForwardSearch("");
          }
        }}
      >
        <DialogContent data-testid="dialog-forward">
          <DialogHeader>
            <DialogTitle>Teruskan pesan</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={forwardSearch}
              onChange={(e) => setForwardSearch(e.target.value)}
              placeholder="Cari chat…"
              className="w-full pl-8 pr-3 py-2 text-sm rounded-md border bg-background"
              data-testid="input-forward-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto -mx-1 px-1">
            {forwardChatsLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Memuat chat…
              </p>
            ) : (
              (() => {
                const q = forwardSearch.trim().toLowerCase();
                const candidates = (forwardChats ?? [])
                  .filter((c) => c.id !== chatId)
                  .filter((c) => {
                    if (!q) return true;
                    return (
                      c.contactName.toLowerCase().includes(q) ||
                      (c.nickname ?? "").toLowerCase().includes(q) ||
                      c.phoneNumber.toLowerCase().includes(q)
                    );
                  });
                if (candidates.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      Tidak ada chat ditemukan.
                    </p>
                  );
                }
                return candidates.map((c) => {
                  const selected = forwardSelected.has(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleForwardTarget(c.id)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-2 rounded-md text-left hover:bg-accent transition-colors",
                        selected && "bg-accent"
                      )}
                      data-testid={`forward-target-${c.id}`}
                    >
                      <ChatAvatar
                        name={c.nickname || c.contactName}
                        profilePicUrl={c.profilePicUrl ?? null}
                        size={32}
                      />
                      <span className="flex-1 min-w-0 truncate text-sm">
                        {c.nickname || c.contactName}
                      </span>
                      {selected && (
                        <Check className="w-4 h-4 text-primary flex-shrink-0" />
                      )}
                    </button>
                  );
                });
              })()
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForwardSource(null)}
              disabled={forwardMut.isPending}
              data-testid="button-forward-cancel"
            >
              Batal
            </Button>
            <Button
              onClick={submitForward}
              disabled={forwardSelected.size === 0 || forwardMut.isPending}
              data-testid="button-forward-confirm"
            >
              {forwardMut.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Share2 className="w-4 h-4 mr-2" />
              )}
              Teruskan
              {forwardSelected.size > 0 ? ` (${forwardSelected.size})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
