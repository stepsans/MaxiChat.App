import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCredentialContactsStatus,
  useSyncCredentialContacts,
  getGetCredentialContactsStatusQueryKey,
  type Credential,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  Contact as ContactIcon,
} from "lucide-react";

export default function ContactSyncCard({
  credentials,
}: {
  credentials: Credential[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isSuperAdmin } = usePermissions();
  const [open, setOpen] = useState(false);

  const contactCreds = credentials.filter(
    (c) => c.type === "googleContactsApi"
  );
  const connected =
    contactCreds.find((c) => c.status === "connected") ?? contactCreds[0] ?? null;
  const credId = connected?.id ?? 0;
  const isConnected = connected?.status === "connected";

  const { data: status, isFetching: statusLoading } =
    useGetCredentialContactsStatus(credId, {
      query: {
        queryKey: getGetCredentialContactsStatusQueryKey(credId),
        enabled: !!credId && isConnected,
        refetchInterval: 60_000,
      },
    });
  const count = status?.count ?? 0;

  const syncMut = useSyncCredentialContacts({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({
          queryKey: getGetCredentialContactsStatusQueryKey(credId),
        });
        const r = res as { count?: number };
        toast({
          title: "Kontak ter-sync",
          description: `${r.count ?? 0} kontak tersimpan dari Google Contacts.`,
        });
      },
      onError: (e: unknown) => {
        const err = e as { data?: { error?: string }; message?: string };
        toast({
          title: "Sync gagal",
          description: err?.data?.error || err?.message || "Server error",
          variant: "destructive",
        });
      },
    },
  });

  const statusIcon = isConnected ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
  ) : (
    <Circle className="w-3.5 h-3.5 text-muted-foreground" />
  );

  const summary = !connected
    ? "Belum tersambung ke Google Contacts"
    : !isConnected
      ? `${connected.name} · belum connect`
      : `${connected.name} · ${count} kontak tersimpan`;

  return (
    <div className="bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-6 py-2.5 flex items-center gap-3 text-left hover:bg-muted/20"
      >
        <ContactIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">Google Contacts → Nama</div>
          <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5">
            {statusIcon}
            <span>{summary}</span>
          </div>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-6 pb-4 pt-1 space-y-3">
          {!connected ? (
            <div className="text-xs text-muted-foreground">
              Belum ada Google Contacts credential. Tambahkan lewat tombol{" "}
              <strong className="text-foreground">Add credential</strong> di atas,
              lalu pilih <strong className="text-foreground">Google Contacts API</strong>.
            </div>
          ) : !isConnected ? (
            <div className="text-xs text-muted-foreground">
              Credential <strong className="text-foreground">{connected.name}</strong>{" "}
              belum terhubung. Selesaikan koneksi OAuth lewat tombol{" "}
              <strong className="text-foreground">Connect</strong> di tabel di atas.
            </div>
          ) : (
            <>
              {!isSuperAdmin && (
                <p className="text-[11px] text-muted-foreground">
                  Hanya admin utama yang dapat mengubah integrasi ini.
                </p>
              )}
              <div className="text-xs text-muted-foreground">
                {statusLoading ? (
                  "Memuat jumlah kontak…"
                ) : (
                  <>
                    <strong className="text-foreground">{count}</strong> kontak
                    tersimpan. Nama ini dipakai untuk mengenali nomor anggota grup
                    yang belum punya nama.
                  </>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => syncMut.mutate({ id: credId })}
                disabled={syncMut.isPending}
              >
                {syncMut.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                )}
                Sync kontak sekarang
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
