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
} from "lucide-react";
import {
  useListChannels,
  useCreateChannel,
  useUpdateChannel,
  usePairChannel,
  useUnpairChannel,
  useDeleteChannel,
  useGetChannelQr,
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  connected: "Terhubung",
  connecting: "Menghubungkan",
  qr_ready: "Scan QR",
  disconnected: "Tidak terhubung",
  error: "Error",
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

// Modal that drives the pair flow: polls GET /channels/:id/qr every 2s and
// renders the QR data url. Closes itself once the channel reports
// `connected`. Reused for both first-time pairing and re-pairing after
// /unpair.
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
    // Force a refetch on open so the stale cached snapshot doesn't drive
    // the auto-close effect.
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
        // Poll until the socket actually connects. Once status flips to
        // `connected` we close the dialog so the polling stops naturally.
        refetchInterval: enabled ? 2000 : false,
        // Stop hammering /qr once we see a persistent error — the manual
        // "Coba lagi" button lets the user retry explicitly.
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
          // Refresh list so the row reflects the latest status (e.g. user
          // closed the dialog while still in qr_ready).
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
        <div className="flex flex-col items-center justify-center py-4 min-h-[280px]">
          {errorMessage ? (
            <div
              className="w-64 min-h-[16rem] rounded border border-red-500/40 bg-red-500/5 flex flex-col items-center justify-center gap-2 text-red-600 dark:text-red-400 text-sm p-4 text-center"
              data-testid="channel-qr-error"
            >
              <AlertTriangle className="w-6 h-6" />
              <div>{errorMessage}</div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                {isFetching ? (
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                ) : null}
                Coba lagi
              </Button>
            </div>
          ) : qrCode ? (
            <img
              src={qrCode}
              alt="WhatsApp pairing QR"
              className="w-64 h-64 rounded border border-border bg-white p-2"
              data-testid="channel-qr-image"
            />
          ) : (
            <div className="w-64 h-64 rounded border border-dashed border-border flex flex-col items-center justify-center gap-2 text-foreground/55 text-sm">
              <Loader2 className="w-6 h-6 animate-spin" />
              {status === "connecting"
                ? "Menyiapkan QR…"
                : status === "connected"
                  ? "Terhubung!"
                  : "Memuat…"}
            </div>
          )}
          <div className="mt-3 text-xs text-foreground/60">
            Status: <StatusBadge status={status} />
            {isFetching && qrCode && (
              <span className="ml-2 inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                memeriksa…
              </span>
            )}
          </div>
        </div>
        <DialogFooter>
          {channelId != null &&
            (status === "connecting" || status === "qr_ready") && (
              <Button
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate({ id: channelId })}
                data-testid="channel-pair-cancel"
              >
                {cancel.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                ) : null}
                Batalkan pairing
              </Button>
            )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Tutup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRow({
  channel,
  onPair,
}: {
  channel: Channel;
  onPair: (id: number) => void;
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
  }, [channel.id, channel.label, channel.color, channel.icon]);

  const dirty =
    label.trim() !== channel.label ||
    color !== channel.color ||
    icon.trim() !== channel.icon;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });

  const errorMsg = (err: unknown, fallback: string) =>
    (err as { data?: { error?: string } } | null)?.data?.error ??
    (err as Error | null)?.message ??
    fallback;

  const update = useUpdateChannel({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Channel diperbarui", duration: 2000 });
      },
      onError: (err) =>
        toast({
          title: "Gagal",
          description: errorMsg(err, "Gagal memperbarui"),
          variant: "destructive",
        }),
    },
  });

  const pair = usePairChannel({
    mutation: {
      onSuccess: () => {
        invalidate();
        onPair(channel.id);
      },
      onError: (err) =>
        toast({
          title: "Gagal mulai pairing",
          description: errorMsg(err, "Gagal"),
          variant: "destructive",
        }),
    },
  });

  const unpair = useUnpairChannel({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "WhatsApp diputus" });
      },
      onError: (err) =>
        toast({
          title: "Gagal memutus",
          description: errorMsg(err, "Gagal"),
          variant: "destructive",
        }),
    },
  });

  const del = useDeleteChannel({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Channel dihapus" });
        setConfirmDelete(false);
      },
      onError: (err) => {
        toast({
          title: "Gagal menghapus",
          description: errorMsg(err, "Gagal"),
          variant: "destructive",
        });
        setConfirmDelete(false);
      },
    },
  });

  const canPair =
    channel.kind === "whatsapp" &&
    (channel.status === "disconnected" ||
      channel.status === "error" ||
      channel.status === "qr_ready" ||
      channel.status === "connecting");
  const canUnpair =
    channel.kind === "whatsapp" && channel.status === "connected";

  return (
    <div
      className="flex flex-col gap-3 p-4 border border-border rounded-lg bg-background"
      data-testid={`channel-row-${channel.id}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3 sm:w-48 min-w-0">
          <span
            className="inline-block w-4 h-4 rounded-full flex-shrink-0 ring-2 ring-background shadow-sm"
            style={{ backgroundColor: channel.color }}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-foreground/55">
              {channel.kind}
            </div>
            <div className="text-sm font-semibold truncate">
              {channel.label}
            </div>
            {channel.ownerPhone && (
              <div className="text-[11px] text-foreground/55 font-mono truncate">
                +{channel.ownerPhone}
              </div>
            )}
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
        {canPair && (
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
        {canUnpair && (
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
              Ini akan memutus WhatsApp dan{" "}
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
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#25D366");

  useEffect(() => {
    if (open) {
      setLabel("");
      setColor("#25D366");
    }
  }, [open]);

  const create = useCreateChannel({
    mutation: {
      onSuccess: (created) => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({
          title: "Channel dibuat",
          description: "Pindai QR untuk menghubungkan WhatsApp.",
        });
        onOpenChange(false);
        // Auto-open the pair dialog so the user goes straight from
        // "create" → "scan QR" without a second click.
        onCreated(created.id);
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
            Saat ini hanya WhatsApp yang aktif. Channel lain (Instagram,
            Shopee, dll.) akan menyusul.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="new-channel-label">Label</Label>
            <Input
              id="new-channel-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="WhatsApp 2"
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
                    kind: "whatsapp",
                    label: label.trim(),
                    color,
                    icon: "whatsapp",
                  },
                },
                {
                  onSuccess: (created) => {
                    // Kick off pairing immediately so the QR is ready by the
                    // time the pair dialog opens.
                    pair.mutate({ id: created.id });
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

  const channels = useMemo(() => data ?? [], [data]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Kelola Channel</h1>
          <p className="text-sm text-foreground/60 mt-1">
            Setiap channel adalah satu akun yang terhubung — saat ini WhatsApp.
            Warna dan ikon di sini muncul di switcher header dan badge percakapan.
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
            />
          ))}
        </div>
      )}

      <AddChannelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(id) => setPairChannelId(id)}
      />
      <PairDialog
        channelId={pairChannelId}
        open={pairChannelId != null}
        onOpenChange={(v) => {
          if (!v) setPairChannelId(null);
        }}
      />
    </div>
  );
}
