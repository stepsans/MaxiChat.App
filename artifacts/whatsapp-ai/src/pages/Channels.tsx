import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Wifi, WifiOff, AlertTriangle } from "lucide-react";
import {
  useListChannels,
  useCreateChannel,
  useUpdateChannel,
  getListChannelsQueryKey,
  type Channel,
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
  disconnected: "Tidak terhubung",
  error: "Error",
};

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "connected"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : status === "connecting"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : status === "error"
          ? "bg-red-500/15 text-red-600 dark:text-red-400"
          : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
  const Icon =
    status === "connected" ? Wifi : status === "error" ? AlertTriangle : WifiOff;
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

function ChannelRow({ channel }: { channel: Channel }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState(channel.label);
  const [color, setColor] = useState(channel.color);
  const [icon, setIcon] = useState(channel.icon);

  useEffect(() => {
    setLabel(channel.label);
    setColor(channel.color);
    setIcon(channel.icon);
  }, [channel.id, channel.label, channel.color, channel.icon]);

  const dirty =
    label.trim() !== channel.label ||
    color !== channel.color ||
    icon.trim() !== channel.icon;

  const update = useUpdateChannel({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({ title: "Channel diperbarui", duration: 2000 });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } } | null)?.data?.error ??
          (err as Error | null)?.message ??
          "Gagal memperbarui";
        toast({ title: "Gagal", description: msg, variant: "destructive" });
      },
    },
  });

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 border border-border rounded-lg bg-background"
      data-testid={`channel-row-${channel.id}`}
    >
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
          <div className="text-sm font-semibold truncate">{channel.label}</div>
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
  );
}

function AddChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
        toast({
          title: "Channel dibuat",
          description:
            "Pairing WhatsApp untuk channel baru akan tersedia di rilis berikutnya.",
        });
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } } | null)?.data?.error ??
          (err as Error | null)?.message ??
          "Gagal membuat channel";
        toast({ title: "Gagal", description: msg, variant: "destructive" });
      },
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
              create.mutate({
                data: {
                  kind: "whatsapp",
                  label: label.trim(),
                  color,
                  icon: "whatsapp",
                },
              })
            }
            disabled={create.isPending || label.trim().length === 0}
            data-testid="new-channel-submit"
          >
            {create.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Buat"
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
            <ChannelRow key={c.id} channel={c} />
          ))}
        </div>
      )}

      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
