import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Plus,
  Wifi,
  WifiOff,
  AlertTriangle,
  QrCode,
  LogOut,
  Trash2,
  Send,
} from "lucide-react";
import {
  useListChannels,
  useCreateChannel,
  useUpdateChannel,
  usePairChannel,
  useUnpairChannel,
  useDeleteChannel,
  useGetChannelQr,
  useConnectTelegramChannel,
  useDisconnectTelegramChannel,
  getListChannelsQueryKey,
  getGetChannelQrQueryKey,
  type Channel,
  type ChannelPairQr,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  connected: "Terhubung",
  connecting: "Menghubungkan",
  qr_ready: "Scan QR",
  disconnected: "Tidak terhubung",
  error: "Error",
};

const KIND_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "connected"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : status === "connecting" || status === "qr_ready"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : status === "error"
          ? "bg-red-500/15 text-red-600 dark:text-red-400"
          : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
  const Icon =
    status === "connected"
      ? Wifi
      : status === "qr_ready"
        ? QrCode
        : status === "error"
          ? AlertTriangle
          : WifiOff;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone
      )}
    >
      <Icon className="w-3 h-3" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// Modal that drives the WhatsApp pair flow: polls GET /channels/:id/qr
// every 2s and renders the QR data url. Closes itself once the channel
// reports `connected`. Reused for both first-time pairing and re-pairing
// after /unpair. WhatsApp-only — Telegram uses TelegramTokenDialog.
function PairDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const enabled = open && channelId != null;

  // Track when this open cycle began. We will not honor `status === "connected"`
  // from cached data older than this — otherwise re-opening pair for a
  // previously-connected channel auto-closes the dialog on the stale value
  // before the fresh /qr fetch resolves (architect finding #1).
  const [openedAt, setOpenedAt] = useState<number>(0);
  useEffect(() => {
    if (!open || channelId == null) return;
    setOpenedAt(Date.now());
    queryClient.invalidateQueries({
      queryKey: getGetChannelQrQueryKey(channelId),
    });
  }, [open, channelId, queryClient]);

  const { data, dataUpdatedAt, error, isFetching, refetch } = useGetChannelQr(
    channelId ?? 0,
    {
      query: {
        queryKey: getGetChannelQrQueryKey(channelId ?? 0),
        enabled,
        refetchInterval: enabled ? 2000 : false,
        retry: 1,
      },
    },
  );

  const fresh = dataUpdatedAt > openedAt;

  useEffect(() => {
    if (!open) return;
    if (!fresh) return;
    if (data?.status === "connected") {
      toast({
        title: "WhatsApp terhubung",
        description: data.ownerPhone ? `+${data.ownerPhone}` : undefined,
      });
      queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
      onOpenChange(false);
    }
  }, [
    fresh,
    data?.status,
    data?.ownerPhone,
    open,
    onOpenChange,
    queryClient,
    toast,
  ]);

  const cancel = useUnpairChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Pairing dibatalkan" });
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Gagal membatalkan",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const status: ChannelPairQr["status"] = fresh
    ? (data?.status ?? "connecting")
    : "connecting";
  const qrCode = fresh ? (data?.qrCode ?? null) : null;
  const errorMessage = error
    ? ((error as { data?: { error?: string } } | null)?.data?.error ??
      (error as Error | null)?.message ??
      "Gagal memuat QR.")
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && channelId != null) {
          queryClient.invalidateQueries({
            queryKey: getGetChannelQrQueryKey(channelId),
          });
          queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hubungkan WhatsApp</DialogTitle>
          <DialogDescription>
            Buka WhatsApp di HP Anda → <strong>Setelan</strong> →{" "}
            <strong>Perangkat tertaut</strong> → <strong>Tautkan perangkat</strong>,
            lalu pindai QR di bawah.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-3">
          {errorMessage ? (
            <div className="text-sm text-red-600 text-center">{errorMessage}</div>
          ) : qrCode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrCode}
              alt="QR WhatsApp"
              className="w-64 h-64 border border-border rounded"
              data-testid="pair-qr-image"
            />
          ) : status === "connecting" || isFetching ? (
            <div className="flex flex-col items-center gap-2 py-12 text-foreground/60">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-sm">Menyiapkan QR…</span>
            </div>
          ) : (
            <div className="text-sm text-foreground/60">Status: {status}</div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : null}
            Muat ulang
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() =>
              channelId != null && cancel.mutate({ id: channelId })
            }
            disabled={cancel.isPending || channelId == null}
          >
            Batalkan
          </Button>
          <Button onClick={() => onOpenChange(false)}>Tutup</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Telegram pair dialog: user pastes the bot token from @BotFather; we
// call /connect-telegram which verifies via getMe and registers the
// webhook synchronously, so the dialog closes the moment the channel
// flips to `connected`.
function TelegramTokenDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [token, setToken] = useState("");

  useEffect(() => {
    if (open) setToken("");
  }, [open]);

  const connect = useConnectTelegramChannel({
    mutation: {
      onSuccess: (channel) => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        const username =
          (channel.metadata as { telegram?: { botUsername?: string } } | null)
            ?.telegram?.botUsername;
        toast({
          title: "Telegram terhubung",
          description: username ? `@${username}` : undefined,
        });
        onOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Gagal menghubungkan",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Token ditolak",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Hubungkan Telegram</DialogTitle>
          <DialogDescription>
            Buat bot di Telegram via{" "}
            <strong>@BotFather</strong> → <strong>/newbot</strong>, lalu
            tempelkan token yang diberikan di bawah ini.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="tg-token">Token Bot</Label>
            <Input
              id="tg-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AAH..."
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              data-testid="tg-token-input"
            />
            <p className="text-[11px] text-foreground/55 mt-1">
              Token akan disimpan terenkripsi dan tidak ditampilkan lagi.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={connect.isPending}
          >
            Batal
          </Button>
          <Button
            onClick={() =>
              channelId != null &&
              connect.mutate({
                id: channelId,
                data: { botToken: token.trim() },
              })
            }
            disabled={
              connect.isPending || channelId == null || token.trim().length < 20
            }
            data-testid="tg-token-submit"
          >
            {connect.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <Send className="w-3 h-3 mr-1" />
            )}
            Hubungkan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRow({
  channel,
  onPair,
  onConnectTelegram,
}: {
  channel: Channel;
  onPair: (id: number) => void;
  onConnectTelegram: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState(channel.label);
  const [color, setColor] = useState(channel.color);
  const [icon, setIcon] = useState(channel.icon);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setLabel(channel.label);
    setColor(channel.color);
    setIcon(channel.icon);
  }, [channel.label, channel.color, channel.icon]);

  const dirty =
    label.trim() !== channel.label ||
    color !== channel.color ||
    icon.trim() !== channel.icon;

  const update = useUpdateChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Channel diperbarui" });
      },
      onError: (err) =>
        toast({
          title: "Gagal menyimpan",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const pair = usePairChannel({
    mutation: {
      onSuccess: () => onPair(channel.id),
      onError: (err) =>
        toast({
          title: "Gagal pair",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const unpair = useUnpairChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Diputus" });
      },
      onError: (err) =>
        toast({
          title: "Gagal memutus",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const disconnectTg = useDisconnectTelegramChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Telegram diputus" });
      },
      onError: (err) =>
        toast({
          title: "Gagal memutus",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const del = useDeleteChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Channel dihapus" });
        setConfirmDelete(false);
      },
      onError: (err) =>
        toast({
          title: "Gagal menghapus",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  const isTelegram = channel.kind === "telegram";
  const isWhatsapp = channel.kind === "whatsapp";
  const tgUsername =
    (channel.metadata as { telegram?: { botUsername?: string } } | null)
      ?.telegram?.botUsername ?? null;

  // Connect button visibility:
  // - WhatsApp: show whenever not currently connected; label changes based on
  //   whether a number has been paired before.
  // - Telegram: show when no bot bound yet OR explicitly disconnected.
  const canPairWa = isWhatsapp && channel.status !== "connected";
  const canConnectTg = isTelegram && !tgUsername;
  const canDisconnect = channel.status === "connected";

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 bg-card">
      <div className="flex flex-wrap items-start gap-3">
        <div
          className="w-10 h-10 rounded flex items-center justify-center text-white font-semibold text-sm"
          style={{ backgroundColor: color }}
        >
          {(KIND_LABEL[channel.kind] ?? channel.kind).slice(0, 2)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{channel.label}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-foreground/10 text-foreground/70">
              {KIND_LABEL[channel.kind] ?? channel.kind}
            </span>
          </div>
          <div className="text-xs text-foreground/55 mt-0.5">
            {isWhatsapp && channel.ownerPhone ? `+${channel.ownerPhone}` : null}
            {isTelegram && tgUsername ? `@${tgUsername}` : null}
            {!channel.ownerPhone && !tgUsername ? (
              <span className="italic">Belum terhubung</span>
            ) : null}
          </div>
        </div>
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <Label htmlFor={`label-${channel.id}`} className="text-[11px]">
              Label
            </Label>
            <Input
              id={`label-${channel.id}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              className="h-8 text-sm"
              data-testid={`channel-label-${channel.id}`}
            />
          </div>
          <div>
            <Label htmlFor={`color-${channel.id}`} className="text-[11px]">
              Warna
            </Label>
            <div className="flex items-center gap-2">
              <input
                id={`color-${channel.id}`}
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded border border-border cursor-pointer bg-transparent"
                data-testid={`channel-color-${channel.id}`}
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
                className="h-8 text-sm font-mono flex-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor={`icon-${channel.id}`} className="text-[11px]">
              Ikon
            </Label>
            <Input
              id={`icon-${channel.id}`}
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={40}
              className="h-8 text-sm"
              data-testid={`channel-icon-${channel.id}`}
            />
          </div>
        </div>
        <div className="flex sm:flex-col items-end gap-2 sm:w-32">
          <StatusBadge status={channel.status} />
          <Button
            size="sm"
            disabled={!dirty || update.isPending}
            onClick={() =>
              update.mutate({
                id: channel.id,
                data: {
                  label: label.trim(),
                  color,
                  icon: icon.trim(),
                },
              })
            }
            data-testid={`channel-save-${channel.id}`}
          >
            {update.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Simpan"
            )}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-border/60">
        {canPairWa && (
          <Button
            size="sm"
            variant="outline"
            disabled={pair.isPending}
            onClick={() => pair.mutate({ id: channel.id })}
            data-testid={`channel-pair-${channel.id}`}
          >
            {pair.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <QrCode className="w-3 h-3 mr-1" />
            )}
            {channel.ownerPhone ? "Hubungkan ulang" : "Hubungkan WhatsApp"}
          </Button>
        )}
        {canConnectTg && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onConnectTelegram(channel.id)}
            data-testid={`channel-connect-telegram-${channel.id}`}
          >
            <Send className="w-3 h-3 mr-1" />
            Hubungkan Telegram
          </Button>
        )}
        {canDisconnect && isWhatsapp && (
          <Button
            size="sm"
            variant="outline"
            disabled={unpair.isPending}
            onClick={() => unpair.mutate({ id: channel.id })}
            data-testid={`channel-unpair-${channel.id}`}
          >
            {unpair.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <LogOut className="w-3 h-3 mr-1" />
            )}
            Putus
          </Button>
        )}
        {canDisconnect && isTelegram && (
          <Button
            size="sm"
            variant="outline"
            disabled={disconnectTg.isPending}
            onClick={() => disconnectTg.mutate({ id: channel.id })}
            data-testid={`channel-disconnect-telegram-${channel.id}`}
          >
            {disconnectTg.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <LogOut className="w-3 h-3 mr-1" />
            )}
            Putus
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-600 hover:text-red-700 hover:bg-red-500/10"
          disabled={del.isPending}
          onClick={() => setConfirmDelete(true)}
          data-testid={`channel-delete-${channel.id}`}
        >
          {del.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin mr-1" />
          ) : (
            <Trash2 className="w-3 h-3 mr-1" />
          )}
          Hapus
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hapus channel "{channel.label}"?</DialogTitle>
            <DialogDescription>
              Ini akan memutus koneksi dan{" "}
              <strong>menghapus semua chat, pesan, status, pengaturan, dan flow</strong>{" "}
              yang terikat ke channel ini. Tindakan ini tidak bisa dibatalkan.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={del.isPending}
            >
              Batal
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() => del.mutate({ id: channel.id })}
              data-testid={`channel-delete-confirm-${channel.id}`}
            >
              {del.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin mr-1" />
              ) : null}
              Hapus permanen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddChannelDialog({
  open,
  onOpenChange,
  onCreatedWa,
  onCreatedTg,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreatedWa: (id: number) => void;
  onCreatedTg: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [kind, setKind] = useState<"whatsapp" | "telegram">("whatsapp");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#25D366");

  useEffect(() => {
    if (open) {
      setKind("whatsapp");
      setLabel("");
      setColor("#25D366");
    }
  }, [open]);

  // Reset the color to the kind's signature color when the kind toggles —
  // unless the user has already customised the colour from the previous
  // default. Tracked implicitly: we always reset on switch because the
  // dialog is short-lived and the user can re-pick.
  useEffect(() => {
    setColor(kind === "telegram" ? "#229ED9" : "#25D366");
  }, [kind]);

  const create = useCreateChannel({
    mutation: {
      onSuccess: (created) => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({
          title: "Channel dibuat",
          description:
            created.kind === "telegram"
              ? "Tempelkan token bot Telegram untuk menghubungkan."
              : "Pindai QR untuk menghubungkan WhatsApp.",
        });
        onOpenChange(false);
        if (created.kind === "telegram") onCreatedTg(created.id);
        else onCreatedWa(created.id);
      },
      onError: (err) =>
        toast({
          title: "Gagal",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal membuat channel",
          variant: "destructive",
        }),
    },
  });

  const pair = usePairChannel({
    mutation: {
      onError: (err) =>
        toast({
          title: "Gagal mulai pairing",
          description:
            (err as { data?: { error?: string } } | null)?.data?.error ??
            (err as Error | null)?.message ??
            "Gagal",
          variant: "destructive",
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tambah channel</DialogTitle>
          <DialogDescription>
            Pilih platform yang akan dihubungkan. Setiap channel berdiri
            sendiri — pengaturan AI, knowledge, dan flow di-share di seluruh
            channel, tetapi percakapan dipisahkan per channel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="new-channel-kind">Platform</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as "whatsapp" | "telegram")}
            >
              <SelectTrigger id="new-channel-kind" data-testid="new-channel-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="new-channel-label">Label</Label>
            <Input
              id="new-channel-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={kind === "telegram" ? "Telegram Bot CS" : "WhatsApp 2"}
              maxLength={60}
              data-testid="new-channel-label"
            />
          </div>
          <div>
            <Label htmlFor="new-channel-color">Warna</Label>
            <div className="flex items-center gap-2">
              <input
                id="new-channel-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-10 h-10 rounded border border-border cursor-pointer bg-transparent"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
                className="font-mono flex-1"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Batal
          </Button>
          <Button
            onClick={() =>
              create.mutate(
                {
                  data: {
                    kind,
                    label: label.trim(),
                    color,
                    icon: kind,
                  },
                },
                {
                  onSuccess: (created) => {
                    // WhatsApp needs an immediate pair kick so the QR is
                    // primed by the time PairDialog opens. Telegram doesn't
                    // — we wait for the user to paste the token.
                    if (created.kind === "whatsapp") {
                      pair.mutate({ id: created.id });
                    }
                  },
                }
              )
            }
            disabled={create.isPending || label.trim().length === 0}
            data-testid="new-channel-submit"
          >
            {create.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Buat & hubungkan"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Channels() {
  const { data, isLoading } = useListChannels();
  const [addOpen, setAddOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("add") === "1";
  });
  const [pairChannelId, setPairChannelId] = useState<number | null>(null);
  const [tgChannelId, setTgChannelId] = useState<number | null>(null);

  const channels = useMemo(() => data ?? [], [data]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Kelola Channel</h1>
          <p className="text-sm text-foreground/60 mt-1">
            Setiap channel adalah satu akun yang terhubung — WhatsApp atau
            Telegram. Warna dan ikon di sini muncul di switcher header dan
            badge percakapan.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="channel-add-button">
          <Plus className="w-4 h-4 mr-1" />
          Tambah
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-foreground/50">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : channels.length === 0 ? (
        <div className="text-center py-20 text-foreground/55">
          Belum ada channel. Klik <strong>Tambah</strong> untuk memulai.
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onPair={(id) => setPairChannelId(id)}
              onConnectTelegram={(id) => setTgChannelId(id)}
            />
          ))}
        </div>
      )}

      <AddChannelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreatedWa={(id) => setPairChannelId(id)}
        onCreatedTg={(id) => setTgChannelId(id)}
      />
      <PairDialog
        channelId={pairChannelId}
        open={pairChannelId != null}
        onOpenChange={(v) => {
          if (!v) setPairChannelId(null);
        }}
      />
      <TelegramTokenDialog
        channelId={tgChannelId}
        open={tgChannelId != null}
        onOpenChange={(v) => {
          if (!v) setTgChannelId(null);
        }}
      />
    </div>
  );
}
