import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetChat,
  useUpdateChat,
  useSendManualReply,
  useTakeoverChat,
  getGetChatQueryKey,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  useListProducts,
  getListProductsQueryKey,
  useSendProductToChat,
} from "@workspace/api-client-react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

type MediaKind = "image" | "video" | "document";

export default function ChatDetail() {
  const { id } = useParams<{ id: string }>();
  const chatId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reply, setReply] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFileKind, setPendingFileKind] = useState<MediaKind>("document");
  const [uploading, setUploading] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [sendingContact, setSendingContact] = useState(false);
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
    // defer one tick so the accept attr update applies
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file
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
        toast({ title: "Reply sent." });
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

  useEffect(() => {
    if (chat) {
      qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
    }
  }, [chat?.id]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Chat not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-border flex-shrink-0">
        <Link
          href="/chats"
          data-testid="button-back-to-chats"
          className="p-1.5 rounded-md hover:bg-accent transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold flex-shrink-0">
          {chat.contactName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{chat.contactName}</p>
          <p className="text-xs text-muted-foreground">
            {chat.phoneNumber.endsWith("@g.us") ? "Grup" : chat.phoneNumber}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          <Select
            value={chat.tag}
            onValueChange={(val) =>
              updateChat.mutate({ id: chatId, data: { tag: val as any } })
            }
          >
            <SelectTrigger data-testid="select-chat-tag" className="h-7 w-32 text-xs">
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
            <SelectTrigger data-testid="select-chat-status" className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai_handled">AI Handled</SelectItem>
              <SelectItem value="needs_human">Needs Human</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>

          <Sheet open={productPanelOpen} onOpenChange={setProductPanelOpen}>
            <SheetTrigger asChild>
              <Button
                data-testid="button-open-products"
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
              >
                <Package className="w-3.5 h-3.5" />
                Kirim Produk
              </Button>
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
                              src={p.imageUrl}
                              alt={p.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Package className="w-5 h-5 opacity-30" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {p.code}
                          </p>
                          <p className="text-xs font-medium line-clamp-2">
                            {p.name}
                          </p>
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

          <div className="flex items-center gap-2">
            <Switch
              data-testid="switch-human-takeover"
              id="takeover"
              checked={chat.isHumanTakeover}
              onCheckedChange={(checked) =>
                takeover.mutate({ id: chatId, data: { takeover: checked } })
              }
            />
            <Label htmlFor="takeover" className="text-xs text-muted-foreground">
              Human mode
            </Label>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {chat.messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">No messages yet</p>
          </div>
        ) : (
          chat.messages.map((msg: any) => {
            const isOutbound = msg.direction === "outbound";
            const mediaType: string | null = msg.mediaType ?? null;
            const mediaUrl: string | null = msg.mediaUrl ?? null;
            return (
              <div
                key={msg.id}
                data-testid={`message-${msg.id}`}
                className={cn("flex", isOutbound ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[70%] rounded-lg px-3 py-2 text-sm space-y-1.5",
                    isOutbound
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-foreground"
                  )}
                >
                  {mediaType === "image" && mediaUrl && (
                    <a href={mediaUrl} target="_blank" rel="noreferrer">
                      <img
                        src={mediaUrl}
                        alt={msg.mediaFilename ?? "image"}
                        className="rounded-md max-h-72 object-cover"
                      />
                    </a>
                  )}
                  {mediaType === "video" && mediaUrl && (
                    <video
                      src={mediaUrl}
                      controls
                      className="rounded-md max-h-72 w-full"
                    />
                  )}
                  {mediaType === "audio" && mediaUrl && (
                    <audio src={mediaUrl} controls className="w-full" />
                  )}
                  {mediaType === "document" && mediaUrl && (
                    <a
                      href={mediaUrl}
                      target="_blank"
                      rel="noreferrer"
                      download={msg.mediaFilename ?? undefined}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5",
                        isOutbound ? "bg-primary-foreground/10" : "bg-foreground/5"
                      )}
                    >
                      <FileText className="w-5 h-5 flex-shrink-0 opacity-80" />
                      <span className="truncate text-xs underline">
                        {msg.mediaFilename ?? "Document"}
                      </span>
                      <Download className="w-3.5 h-3.5 opacity-60 ml-auto" />
                    </a>
                  )}
                  {mediaType === "contact" && (
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5",
                        isOutbound ? "bg-primary-foreground/10" : "bg-foreground/5"
                      )}
                    >
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
                    <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  )}
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] opacity-60">
                      {format(new Date(msg.createdAt), "HH:mm")}
                    </span>
                    {isOutbound && msg.isAiGenerated && (
                      <Bot className="w-2.5 h-2.5 opacity-60" />
                    )}
                    {isOutbound && !msg.isAiGenerated && (
                      <UserCheck className="w-2.5 h-2.5 opacity-60" />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reply Box */}
      <div className="px-4 py-3 border-t border-border flex-shrink-0">
        {chat.isHumanTakeover && (
          <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
            <UserCheck className="w-3 h-3" />
            Human mode — AI auto-reply is paused for this chat
          </p>
        )}
        <div className="flex gap-2 items-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="button-attach"
                variant="outline"
                size="sm"
                className="self-end"
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Paperclip className="w-4 h-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
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

          <Textarea
            data-testid="textarea-reply"
            placeholder="Ketik balasan atau caption..."
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            className="resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (reply.trim()) {
                  sendReply.mutate({ id: chatId, data: { content: reply.trim() } });
                }
              }
            }}
          />
          <Button
            data-testid="button-send-reply"
            onClick={() => {
              if (reply.trim()) {
                sendReply.mutate({ id: chatId, data: { content: reply.trim() } });
              }
            }}
            disabled={sendReply.isPending || !reply.trim()}
            size="sm"
            className="self-end"
          >
            {sendReply.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
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
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Kirim"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
