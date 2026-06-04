import { useState } from "react";
import {
  useListAiReviewConfigs,
  getListAiReviewConfigsQueryKey,
  type Credential,
  type AiReviewConfig,
} from "@workspace/api-client-react";
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  FolderUp,
} from "lucide-react";
import { SiGoogledrive } from "react-icons/si";
import { usePermissions } from "@/hooks/use-permissions";

export default function DriveSyncCard({
  credentials,
}: {
  credentials: Credential[];
}) {
  const { isSuperAdmin } = usePermissions();
  const [open, setOpen] = useState(false);

  const driveCreds = credentials.filter((c) => c.type === "googleDriveOAuth2Api");
  const connected =
    driveCreds.find((c) => c.status === "connected") ?? driveCreds[0] ?? null;
  const isConnected = connected?.status === "connected";

  const { data: configs } = useListAiReviewConfigs({
    query: {
      queryKey: getListAiReviewConfigsQueryKey(),
      enabled: isConnected,
    },
  });
  const usingDrive: AiReviewConfig[] = (configs ?? []).filter(
    (c) => !!c.driveCredentialId
  );

  const statusIcon = isConnected ? (
    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
  ) : (
    <Circle className="w-3.5 h-3.5 text-muted-foreground" />
  );

  const summary = !connected
    ? "Belum tersambung ke Google Drive"
    : !isConnected
      ? `${connected.name} · belum connect`
      : usingDrive.length > 0
        ? `${connected.name} · ${usingDrive.length} grup simpan foto ke Drive`
        : `${connected.name} · belum ada grup yang pakai Drive`;

  return (
    <div className="bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-6 py-2.5 flex items-center gap-3 text-left hover:bg-muted/20"
      >
        <SiGoogledrive className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">Files to Google Drive</div>
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
              Belum ada Google Drive credential. Tambahkan lewat tombol{" "}
              <strong className="text-foreground">Add credential</strong> di atas,
              lalu pilih <strong className="text-foreground">Google Drive OAuth2 API</strong>.
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
                Foto dari grup (menu <strong className="text-foreground">AI Review</strong>)
                otomatis tersimpan ke folder Drive. Folder dipilih per grup di menu AI
                Review.
              </div>
              {usingDrive.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase text-muted-foreground">
                    Grup yang menyimpan ke Drive
                  </div>
                  <div className="border border-border rounded-md divide-y divide-border">
                    {usingDrive.map((c) => (
                      <div
                        key={c.id}
                        className="px-3 py-2 flex items-center gap-2 text-xs"
                      >
                        <FolderUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="font-medium truncate">{c.groupName}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-muted-foreground truncate">
                          {c.driveFolderName || "folder Drive"}
                        </span>
                        {!c.enabled && (
                          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            nonaktif
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Belum ada grup yang dikonfigurasi menyimpan foto ke Drive. Buka menu{" "}
                  <strong className="text-foreground">AI Review</strong>, pilih grup, lalu
                  set credential + folder Drive.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
