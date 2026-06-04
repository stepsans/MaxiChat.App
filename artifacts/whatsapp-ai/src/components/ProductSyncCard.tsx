import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProductSyncConfig,
  useUpsertProductSyncConfig,
  useRunProductSync,
  useListCredentials,
  useListCredentialSpreadsheets,
  useListCredentialSpreadsheetTabs,
  getGetProductSyncConfigQueryKey,
  getListCredentialSpreadsheetsQueryKey,
  getListCredentialSpreadsheetTabsQueryKey,
  getListProductsQueryKey,
  type Credential,
  type ProductSyncConfig,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/SearchableSelect";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Circle,
  ChevronDown,
  ChevronUp,
  Link2,
  Unlink,
} from "lucide-react";
import { SiGoogle } from "react-icons/si";

const INTERVALS: { value: 5 | 15 | 30 | 60; label: string }[] = [
  { value: 5, label: "Setiap 5 menit" },
  { value: 15, label: "Setiap 15 menit" },
  { value: 30, label: "Setiap 30 menit" },
  { value: 60, label: "Setiap 60 menit" },
];

function formatLast(d: string | null | undefined): string {
  if (!d) return "Belum pernah";
  const t = new Date(d);
  const diff = Date.now() - t.getTime();
  if (diff < 60_000) return "Baru saja";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m lalu`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}j lalu`;
  return t.toLocaleString();
}

export default function ProductSyncCard({
  onActiveChange,
}: {
  onActiveChange?: (active: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isSuperAdmin } = usePermissions();
  const [open, setOpen] = useState(false);

  const { data: cfgResp, isLoading: cfgLoading } = useGetProductSyncConfig({
    query: { queryKey: getGetProductSyncConfigQueryKey(), refetchInterval: 30_000 },
  });
  const cfg: ProductSyncConfig | null = cfgResp?.config ?? null;

  const { data: credResp } = useListCredentials();
  const credentials: Credential[] = (credResp ?? []).filter((c) =>
    c.type === "googleSheetsOAuth2Api" || c.type === "googleSheetsTriggerOAuth2Api"
  );

  // Local draft state; hydrated from server on first load and after each save.
  const [credentialId, setCredentialId] = useState<number | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState<string>("");
  const [sheetName, setSheetName] = useState<string>("");
  const [headerRow, setHeaderRow] = useState<number>(1);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState<boolean>(false);
  const [intervalMinutes, setIntervalMinutes] = useState<5 | 15 | 30 | 60>(15);
  useEffect(() => {
    if (!cfg) return;
    setCredentialId(cfg.credentialId);
    setSpreadsheetId(cfg.spreadsheetId);
    setSheetName(cfg.sheetName);
    setHeaderRow(cfg.headerRow);
    setAutoSyncEnabled(cfg.autoSyncEnabled);
    setIntervalMinutes(cfg.intervalMinutes as 5 | 15 | 30 | 60);
  }, [cfg]);

  useEffect(() => {
    onActiveChange?.(!!cfg?.autoSyncEnabled);
  }, [cfg?.autoSyncEnabled, onActiveChange]);

  const selectedCred = credentials.find((c) => c.id === credentialId) ?? null;
  const credReady = !!selectedCred && selectedCred.status === "connected";

  const { data: sheets, isFetching: sheetsLoading } = useListCredentialSpreadsheets(
    credentialId ?? 0,
    {
      query: {
        queryKey: getListCredentialSpreadsheetsQueryKey(credentialId ?? 0),
        enabled: !!credentialId && credReady,
      },
    }
  );
  const { data: tabs, isFetching: tabsLoading } = useListCredentialSpreadsheetTabs(
    credentialId ?? 0,
    spreadsheetId,
    {
      query: {
        queryKey: getListCredentialSpreadsheetTabsQueryKey(
          credentialId ?? 0,
          spreadsheetId
        ),
        enabled: !!credentialId && credReady && !!spreadsheetId,
      },
    }
  );

  const saveMut = useUpsertProductSyncConfig({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetProductSyncConfigQueryKey() });
        toast({ title: "Pengaturan sync disimpan" });
      },
      onError: (e: unknown) => {
        const err = e as { data?: { error?: string }; message?: string };
        toast({
          title: "Gagal menyimpan",
          description: err?.data?.error || err?.message || "Server error",
          variant: "destructive",
        });
      },
    },
  });
  const runMut = useRunProductSync({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetProductSyncConfigQueryKey() });
        const r = res as { inserted?: number; updated?: number; deleted?: number };
        toast({
          title: "Sync selesai",
          description: `+${r.inserted ?? 0} baru · ${r.updated ?? 0} diupdate · −${r.deleted ?? 0} dihapus`,
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

  const canSave = !!credentialId && !!spreadsheetId && !!sheetName && headerRow >= 1;
  function save(overrides?: {
    autoSyncEnabled?: boolean;
    intervalMinutes?: 5 | 15 | 30 | 60;
  }) {
    if (!canSave) {
      toast({
        title: "Lengkapi credential, spreadsheet, dan tab dulu",
        variant: "destructive",
      });
      return;
    }
    saveMut.mutate({
      data: {
        credentialId: credentialId!,
        spreadsheetId,
        sheetName,
        headerRow,
        autoSyncEnabled: overrides?.autoSyncEnabled ?? autoSyncEnabled,
        intervalMinutes: overrides?.intervalMinutes ?? intervalMinutes,
      },
    });
  }

  function unbind() {
    // Server treats `null` body as "clear binding".
    saveMut.mutate({ data: null as unknown as never });
    setCredentialId(null);
    setSpreadsheetId("");
    setSheetName("");
    setAutoSyncEnabled(false);
  }

  const statusIcon =
    cfg?.lastSyncStatus === "ok" ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    ) : cfg?.lastSyncStatus === "error" ? (
      <AlertCircle className="w-3.5 h-3.5 text-destructive" />
    ) : (
      <Circle className="w-3.5 h-3.5 text-muted-foreground" />
    );

  const summary = useMemo(() => {
    if (!cfg) return "Belum tersambung ke Google Sheets";
    const tab = cfg.sheetName;
    const cred = credentials.find((c) => c.id === cfg.credentialId);
    return `${cred?.name ?? "credential"} · ${tab} · ${cfg.autoSyncEnabled ? `auto setiap ${cfg.intervalMinutes}m` : "manual"}`;
  }, [cfg, credentials]);

  return (
    <div className="border-b border-border bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-6 py-2.5 flex items-center gap-3 text-left hover:bg-muted/20 bg-[#ff800033]"
      >
        <SiGoogle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium flex items-center gap-2">
            Product to Google Sheet
            {cfg?.autoSyncEnabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500">
                AUTO
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5">
            {statusIcon}
            <span>{summary}</span>
            {cfg && (
              <span className="ml-2">· terakhir: {formatLast(cfg.lastSyncedAt)}</span>
            )}
          </div>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-6 pb-4 pt-1 grid grid-cols-1 md:grid-cols-2 gap-4">
          {cfgLoading ? (
            <div className="text-xs text-muted-foreground">Memuat…</div>
          ) : credentials.length === 0 ? (
            <div className="text-xs text-muted-foreground md:col-span-2">
              Belum ada Google credential. Tambahkan lewat tombol{" "}
              <strong className="text-foreground">Add credential</strong> di atas.
            </div>
          ) : (
            <>
              {!isSuperAdmin && (
                <p className="md:col-span-2 text-[11px] text-muted-foreground">
                  Hanya admin utama yang dapat mengubah integrasi ini.
                </p>
              )}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase text-muted-foreground">
                  Credential
                </Label>
                <Select
                  value={credentialId ? String(credentialId) : ""}
                  onValueChange={(v) => {
                    setCredentialId(Number(v));
                    setSpreadsheetId("");
                    setSheetName("");
                  }}
                  disabled={!isSuperAdmin}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Pilih credential…" />
                  </SelectTrigger>
                  <SelectContent>
                    {credentials.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                        {c.status !== "connected" && (
                          <span className="ml-2 text-destructive">(not connected)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase text-muted-foreground">
                  Spreadsheet
                </Label>
                <SearchableSelect
                  value={spreadsheetId}
                  onChange={(v) => {
                    setSpreadsheetId(v);
                    setSheetName("");
                  }}
                  options={(sheets ?? []).map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  disabled={!isSuperAdmin || !credReady}
                  placeholder={sheetsLoading ? "Memuat…" : "Pilih spreadsheet…"}
                  searchPlaceholder="Cari spreadsheet…"
                  emptyText="Spreadsheet tidak ditemukan."
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase text-muted-foreground">
                  Tab
                </Label>
                <SearchableSelect
                  value={sheetName}
                  onChange={setSheetName}
                  options={(tabs ?? []).map((t) => ({ value: t, label: t }))}
                  disabled={!isSuperAdmin || !spreadsheetId}
                  placeholder={tabsLoading ? "Memuat…" : "Pilih tab…"}
                  searchPlaceholder="Cari tab…"
                  emptyText="Tab tidak ditemukan."
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase text-muted-foreground">
                  Baris header
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={headerRow}
                  onChange={(e) =>
                    setHeaderRow(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="h-8 text-xs"
                  disabled={!isSuperAdmin}
                />
              </div>

              <div className="md:col-span-2 flex items-center justify-between border-t border-border pt-3">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={autoSyncEnabled}
                    onCheckedChange={(v) => {
                      setAutoSyncEnabled(v);
                      if (canSave) save({ autoSyncEnabled: v });
                    }}
                    disabled={!isSuperAdmin}
                  />
                  <span className="text-xs">Auto-sync</span>
                  <Select
                    value={String(intervalMinutes)}
                    onValueChange={(v) => {
                      const iv = Number(v) as 5 | 15 | 30 | 60;
                      setIntervalMinutes(iv);
                      if (canSave && autoSyncEnabled) save({ intervalMinutes: iv });
                    }}
                    disabled={!isSuperAdmin}
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVALS.map((i) => (
                        <SelectItem key={i.value} value={String(i.value)}>
                          {i.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  {cfg && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={unbind}
                      disabled={!isSuperAdmin || saveMut.isPending}
                    >
                      <Unlink className="w-3.5 h-3.5 mr-1.5" /> Lepas
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => save()}
                    disabled={!isSuperAdmin || !canSave || saveMut.isPending}
                  >
                    {saveMut.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Link2 className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Simpan
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => runMut.mutate()}
                    disabled={!cfg || runMut.isPending}
                  >
                    {runMut.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Sync sekarang
                  </Button>
                </div>
              </div>
              {cfg?.lastSyncStatus === "error" && cfg.lastSyncError && (
                <div className="md:col-span-2 text-xs text-destructive">
                  Error terakhir: {cfg.lastSyncError}
                </div>
              )}
              <div className="md:col-span-2 text-[11px] text-muted-foreground">
                Sheet adalah source of truth — baris yang hilang dari sheet akan
                <strong className="text-foreground"> dihapus</strong> dari katalog saat
                sync.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
