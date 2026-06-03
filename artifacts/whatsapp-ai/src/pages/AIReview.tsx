import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAiReviewGroups,
  getListAiReviewGroupsQueryKey,
  useListAiReviewConfigs,
  useCreateAiReviewConfig,
  useUpdateAiReviewConfig,
  useDeleteAiReviewConfig,
  useRunAiReviewConfig,
  getListAiReviewConfigsQueryKey,
  useListCredentials,
  getListCredentialsQueryKey,
  useListCredentialSpreadsheets,
  getListCredentialSpreadsheetsQueryKey,
  useListCredentialSpreadsheetTabs,
  getListCredentialSpreadsheetTabsQueryKey,
  useCreateCredentialSpreadsheet,
  useListCredentialDriveFolders,
  getListCredentialDriveFoldersQueryKey,
  type AiReviewConfig,
  type AiReviewColumn,
  type AiReviewGroup,
  type Credential,
} from "@workspace/api-client-react";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/SearchableSelect";
import { useToast } from "@/hooks/use-toast";
import {
  ReceiptText,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  Play,
  CheckCircle2,
  AlertCircle,
  Circle,
  GripVertical,
  ExternalLink,
  FolderOpen,
  Clock,
  Sparkles,
} from "lucide-react";

const SHEET_CRED_TYPES = ["googleSheetsOAuth2Api", "googleSheetsTriggerOAuth2Api"];

// Ready-made template for a daily cash report (Laporan Kas Harian). Applying it
// fills both the AI instruction and the matching output columns so the owner can
// start from a working setup instead of writing the prompt from scratch.
const KAS_HARIAN_TEMPLATE: { prompt: string; columns: ColumnDraft[] } = {
  prompt: `Anda adalah asisten pembukuan kas harian toko berbahasa Indonesia. Dari setiap foto nota/struk, tentukan apakah transaksi merupakan PEMASUKAN (uang masuk) atau PENGELUARAN (uang keluar), lalu ekstrak detailnya untuk Laporan Kas Harian.

Aturan:
- Jenis transaksi: nota pembelian/belanja/biaya = Pengeluaran; nota penjualan/setoran/penerimaan = Pemasukan.
- Kolom "Pemasukan" diisi HANYA jika uang masuk, selain itu kosongkan. Kolom "Pengeluaran" diisi HANYA jika uang keluar, selain itu kosongkan.
- Tanggal pakai format YYYY-MM-DD sesuai yang tertera di nota; jika tidak ada, kosongkan.
- Semua nominal ditulis angka saja, tanpa "Rp", tanpa titik/koma ribuan.
- Kategori pilih yang paling sesuai: Penjualan, Pembelian Barang, Operasional, Gaji, Sewa, Listrik/Air/Internet, Transport, atau Lainnya.
- Metode bayar: Tunai atau Transfer sesuai nota; jika tidak jelas, isi "Tunai".
- Keterangan: ringkas isi transaksi (mis. "Beli ATK", "Bayar listrik", "Setoran penjualan harian").`,
  columns: [
    { name: "Tanggal", hint: "Tanggal pada nota, format YYYY-MM-DD" },
    { name: "Keterangan", hint: "Ringkasan transaksi" },
    { name: "Kategori", hint: "Penjualan / Pembelian / Operasional / dll" },
    { name: "Pemasukan", hint: "Nominal uang masuk, angka saja" },
    { name: "Pengeluaran", hint: "Nominal uang keluar, angka saja" },
    { name: "Metode Bayar", hint: "Tunai atau Transfer" },
    { name: "Nama Toko/Vendor", hint: "Nama penjual/toko di nota" },
    { name: "No. Nota", hint: "Nomor struk/nota bila ada" },
  ],
};

function groupShortName(jid: string): string {
  return jid.replace(/@g\.us$/, "");
}

function RunStatusPill({ config }: { config: AiReviewConfig }) {
  const status = config.lastRunStatus;
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {config.lastRunCount} nota terakhir
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="w-3.5 h-3.5" /> Error terakhir
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Circle className="w-3.5 h-3.5" /> Belum pernah jalan
    </span>
  );
}

export default function AIReviewPage() {
  const { isSuperAdmin, menus, isLoading: permsLoading } = usePermissions();
  // canView = may SEE recap configs/results; canManage = may create/edit/run/
  // delete them (owner-only, mirrors the super-admin-only write routes).
  const canView = menus.aiReview.canView;
  const canManage = isSuperAdmin;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [editor, setEditor] = useState<
    | { mode: "create" }
    | { mode: "edit"; config: AiReviewConfig }
    | null
  >(null);
  const [deleting, setDeleting] = useState<AiReviewConfig | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);

  const configsQuery = useListAiReviewConfigs({
    query: {
      queryKey: getListAiReviewConfigsQueryKey(),
      enabled: canView,
    },
  });
  const configs: AiReviewConfig[] = configsQuery.data ?? [];

  const credsQuery = useListCredentials({
    query: { queryKey: getListCredentialsQueryKey(), enabled: canManage },
  });
  const credentials: Credential[] = credsQuery.data ?? [];

  const runMut = useRunAiReviewConfig();
  const deleteMut = useDeleteAiReviewConfig();

  function credLabel(id: number | null): string {
    if (id == null) return "—";
    const c = credentials.find((x) => x.id === id);
    return c ? c.name : `Credential #${id}`;
  }

  async function handleRun(config: AiReviewConfig) {
    setRunningId(config.id);
    try {
      const res = await runMut.mutateAsync({ id: config.id });
      toast({
        title: "Rekap selesai",
        description: `${res.processed} foto diproses, ${res.appended} baris ditulis ke Sheet${
          res.uploaded ? `, ${res.uploaded} foto diunggah ke Drive` : ""
        }${res.errors ? `, ${res.errors} gagal dibaca` : ""}.`,
      });
      await qc.invalidateQueries({ queryKey: getListAiReviewConfigsQueryKey() });
    } catch (err: unknown) {
      const e = err as { data?: { error?: string }; message?: string };
      toast({
        variant: "destructive",
        title: "Gagal menjalankan rekap",
        description: e?.data?.error || e?.message || "Server error",
      });
    } finally {
      setRunningId(null);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await deleteMut.mutateAsync({ id: deleting.id });
      toast({ title: "Konfigurasi dihapus" });
      await qc.invalidateQueries({ queryKey: getListAiReviewConfigsQueryKey() });
    } catch (err: unknown) {
      const e = err as { data?: { error?: string }; message?: string };
      toast({
        variant: "destructive",
        title: "Gagal menghapus",
        description: e?.data?.error || e?.message || "Server error",
      });
    } finally {
      setDeleting(null);
    }
  }

  if (permsLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="p-6">
        <div className="max-w-md mx-auto mt-20 text-center space-y-3">
          <ReceiptText className="w-10 h-10 mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">AI Review</h1>
          <p className="text-sm text-muted-foreground">
            Anda tidak memiliki izin untuk mengakses fitur AI Review.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ReceiptText className="w-5 h-5" /> AI Review
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Rekap nota/struk otomatis. Kasir kirim foto nota ke grup WhatsApp; pada jam
            cut-off harian, AI membaca tiap nota, menulis satu baris per nota ke Google
            Sheet, dan (opsional) menyimpan fotonya ke folder Google Drive.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setEditor({ mode: "create" })}>
            <Plus className="w-4 h-4 mr-1.5" /> Tambah Grup
          </Button>
        )}
      </div>

      {configsQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : configs.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-10 text-center">
          <ReceiptText className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            Belum ada grup yang dikonfigurasi. Klik "Tambah Grup" untuk mulai.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((cfg) => (
            <div
              key={cfg.id}
              className="border border-border rounded-lg p-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium truncate">
                      {cfg.groupName || groupShortName(cfg.groupJid)}
                    </h3>
                    {cfg.enabled ? (
                      <Badge variant="default" className="text-[10px]">
                        Aktif
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        Nonaktif
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {groupShortName(cfg.groupJid)}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={runningId === cfg.id}
                      onClick={() => handleRun(cfg)}
                    >
                      {runningId === cfg.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                      <span className="ml-1.5">Jalankan</span>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditor({ mode: "edit", config: cfg })}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setDeleting(cfg)}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Spreadsheet</p>
                  <p className="font-medium flex items-center gap-1">
                    {cfg.spreadsheetUrl ? (
                      <a
                        href={cfg.spreadsheetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {cfg.sheetTab} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      cfg.sheetTab
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Kolom</p>
                  <p className="font-medium">{cfg.columns.length} kolom</p>
                </div>
                <div>
                  <p className="text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Jam cut-off
                  </p>
                  <p className="font-medium">
                    {cfg.scheduleTime} {cfg.timezone}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground flex items-center gap-1">
                    <FolderOpen className="w-3 h-3" /> Drive
                  </p>
                  <p className="font-medium truncate">
                    {cfg.driveFolderId ? cfg.driveFolderName || "Folder" : "—"}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-border/60">
                <RunStatusPill config={cfg} />
                {cfg.lastRunAt && (
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(cfg.lastRunAt).toLocaleString("id-ID")}
                  </span>
                )}
              </div>
              {cfg.lastRunStatus === "error" && cfg.lastRunError && (
                <p className="text-[11px] text-destructive">{cfg.lastRunError}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {editor && (
        <ConfigEditor
          key={editor.mode === "edit" ? editor.config.id : "create"}
          editor={editor}
          credentials={credentials}
          credLabel={credLabel}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await qc.invalidateQueries({
              queryKey: getListAiReviewConfigsQueryKey(),
            });
          }}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus konfigurasi?</AlertDialogTitle>
            <AlertDialogDescription>
              Rekap otomatis untuk grup "
              {deleting?.groupName || (deleting && groupShortName(deleting.groupJid))}"
              akan dihentikan. Data di Google Sheet & Drive tidak terhapus.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ColumnDraft {
  name: string;
  hint: string;
}

function ConfigEditor({
  editor,
  credentials,
  credLabel,
  onClose,
  onSaved,
}: {
  editor: { mode: "create" } | { mode: "edit"; config: AiReviewConfig };
  credentials: Credential[];
  credLabel: (id: number | null) => string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const existing = editor.mode === "edit" ? editor.config : null;

  const sheetCreds = credentials.filter(
    (c) => SHEET_CRED_TYPES.includes(c.type) && c.status === "connected"
  );
  const driveCreds = credentials.filter(
    (c) => c.type === "googleDriveOAuth2Api" && c.status === "connected"
  );

  const [channelId, setChannelId] = useState<number | null>(
    existing?.channelId ?? null
  );
  const [groupJid, setGroupJid] = useState<string>(existing?.groupJid ?? "");
  const [groupName, setGroupName] = useState<string>(existing?.groupName ?? "");
  const [sheetCredentialId, setSheetCredentialId] = useState<number | null>(
    existing?.sheetCredentialId ?? null
  );
  const [spreadsheetId, setSpreadsheetId] = useState<string>(
    existing?.spreadsheetId ?? ""
  );
  const [spreadsheetUrl, setSpreadsheetUrl] = useState<string | null>(
    existing?.spreadsheetUrl ?? null
  );
  const [sheetTab, setSheetTab] = useState<string>(existing?.sheetTab ?? "");
  const [newSheetTitle, setNewSheetTitle] = useState<string>("");
  const [columns, setColumns] = useState<ColumnDraft[]>(
    existing?.columns.map((c) => ({ name: c.name, hint: c.hint ?? "" })) ?? [
      { name: "Tanggal", hint: "Tanggal pada nota" },
      { name: "Nama Toko", hint: "Nama toko/penjual di nota" },
      { name: "Total", hint: "Total nominal pengeluaran, angka saja" },
    ]
  );
  const [prompt, setPrompt] = useState<string>(existing?.prompt ?? "");
  const [driveCredentialId, setDriveCredentialId] = useState<number | null>(
    existing?.driveCredentialId ?? null
  );
  const [driveFolderId, setDriveFolderId] = useState<string | null>(
    existing?.driveFolderId ?? null
  );
  const [driveFolderName, setDriveFolderName] = useState<string | null>(
    existing?.driveFolderName ?? null
  );
  const [scannerAi, setScannerAi] = useState<boolean>(
    existing?.scannerAi ?? false
  );
  const [scheduleTime, setScheduleTime] = useState<string>(
    existing?.scheduleTime ?? "18:00"
  );
  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true);

  const groupsQuery = useListAiReviewGroups({
    query: { queryKey: getListAiReviewGroupsQueryKey() },
  });
  const groups: AiReviewGroup[] = groupsQuery.data ?? [];

  const spreadsheetsQuery = useListCredentialSpreadsheets(
    sheetCredentialId ?? 0,
    {
      query: {
        queryKey: getListCredentialSpreadsheetsQueryKey(sheetCredentialId ?? 0),
        enabled: sheetCredentialId != null,
      },
    }
  );
  const spreadsheets = spreadsheetsQuery.data ?? [];

  const tabsQuery = useListCredentialSpreadsheetTabs(
    sheetCredentialId ?? 0,
    spreadsheetId,
    {
      query: {
        queryKey: getListCredentialSpreadsheetTabsQueryKey(
          sheetCredentialId ?? 0,
          spreadsheetId
        ),
        enabled: sheetCredentialId != null && !!spreadsheetId,
      },
    }
  );
  const tabs = tabsQuery.data ?? [];

  const foldersQuery = useListCredentialDriveFolders(driveCredentialId ?? 0, {
    query: {
      queryKey: getListCredentialDriveFoldersQueryKey(driveCredentialId ?? 0),
      enabled: driveCredentialId != null,
    },
  });
  const folders = foldersQuery.data ?? [];

  const createSheetMut = useCreateCredentialSpreadsheet();
  const createMut = useCreateAiReviewConfig();
  const updateMut = useUpdateAiReviewConfig();
  const saving = createMut.isPending || updateMut.isPending;

  // When picking a group from the list, the option value is a composite
  // `channelId:groupJid` so the same group present on two channels resolves to
  // the right channel binding.
  function pickGroup(composite: string) {
    const sep = composite.indexOf(":");
    if (sep < 0) return;
    const ch = Number(composite.slice(0, sep));
    const jid = composite.slice(sep + 1);
    setGroupJid(jid);
    setChannelId(ch);
    const g = groups.find((x) => x.channelId === ch && x.groupJid === jid);
    if (g?.name) setGroupName(g.name);
  }

  async function handleCreateSheet() {
    if (sheetCredentialId == null || !newSheetTitle.trim()) return;
    try {
      const res = await createSheetMut.mutateAsync({
        id: sheetCredentialId,
        data: { title: newSheetTitle.trim() },
      });
      setSpreadsheetId(res.id);
      setSpreadsheetUrl(res.url ?? null);
      setSheetTab("Sheet1");
      setNewSheetTitle("");
      toast({ title: "Spreadsheet dibuat", description: res.name });
    } catch (err: unknown) {
      const e = err as { data?: { error?: string }; message?: string };
      toast({
        variant: "destructive",
        title: "Gagal membuat spreadsheet",
        description: e?.data?.error || e?.message || "Server error",
      });
    }
  }

  function setColumn(i: number, patch: Partial<ColumnDraft>) {
    setColumns((cols) => cols.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addColumn() {
    setColumns((cols) => [...cols, { name: "", hint: "" }]);
  }
  function removeColumn(i: number) {
    setColumns((cols) => cols.filter((_, idx) => idx !== i));
  }

  function applyKasHarianTemplate() {
    setPrompt(KAS_HARIAN_TEMPLATE.prompt);
    setColumns(KAS_HARIAN_TEMPLATE.columns.map((c) => ({ ...c })));
    toast({
      title: "Contoh diterapkan",
      description:
        "Instruksi AI & kolom Laporan Kas Harian sudah diisi. Sesuaikan bila perlu.",
    });
  }

  function validate(): string | null {
    if (channelId == null || !groupJid) return "Pilih grup WhatsApp dulu.";
    if (sheetCredentialId == null) return "Pilih credential Google Sheets.";
    if (!spreadsheetId) return "Pilih atau buat spreadsheet.";
    if (!sheetTab) return "Pilih tab (sheet) tujuan.";
    const cleaned = columns
      .map((c) => ({ name: c.name.trim(), hint: c.hint.trim() }))
      .filter((c) => c.name);
    if (cleaned.length === 0) return "Tambahkan minimal satu kolom output.";
    if (!prompt.trim())
      return "Isi Instruksi AI dulu — tanpa instruksi, AI Review tidak akan berjalan.";
    if (driveFolderId && driveCredentialId == null)
      return "Folder Drive dipilih tapi credential Drive belum dipilih.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime))
      return "Format jam cut-off harus HH:MM (mis. 18:00).";
    return null;
  }

  async function handleSave() {
    const err = validate();
    if (err) {
      toast({ variant: "destructive", title: "Lengkapi dulu", description: err });
      return;
    }
    const cleanedColumns: AiReviewColumn[] = columns
      .map((c) => ({ name: c.name.trim(), hint: c.hint.trim() || undefined }))
      .filter((c) => c.name);
    const payload = {
      channelId: channelId!,
      groupJid,
      groupName: groupName || undefined,
      sheetCredentialId: sheetCredentialId!,
      spreadsheetId,
      spreadsheetUrl: spreadsheetUrl ?? null,
      sheetTab,
      columns: cleanedColumns,
      prompt: prompt.trim(),
      driveCredentialId: driveFolderId ? driveCredentialId : null,
      driveFolderId: driveFolderId ?? null,
      driveFolderName: driveFolderId ? driveFolderName : null,
      scannerAi,
      scheduleTime,
      enabled,
    };
    try {
      if (existing) {
        await updateMut.mutateAsync({ id: existing.id, data: payload });
      } else {
        await createMut.mutateAsync({ data: payload });
      }
      toast({ title: existing ? "Konfigurasi diperbarui" : "Grup ditambahkan" });
      await onSaved();
    } catch (e: unknown) {
      const err2 = e as { data?: { error?: string }; message?: string };
      toast({
        variant: "destructive",
        title: "Gagal menyimpan",
        description: err2?.data?.error || err2?.message || "Server error",
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Edit Grup AI Review" : "Tambah Grup AI Review"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Group */}
          <div className="space-y-2">
            <Label>Grup WhatsApp</Label>
            <SearchableSelect
              value={channelId != null && groupJid ? `${channelId}:${groupJid}` : ""}
              onChange={pickGroup}
              options={groups.map((g) => ({
                value: `${g.channelId}:${g.groupJid}`,
                label: `${g.name || groupShortName(g.groupJid)} · ${g.channelName}`,
              }))}
              placeholder={groupsQuery.isLoading ? "Memuat grup…" : "Pilih grup…"}
              searchPlaceholder="Cari grup…"
              emptyText={
                groupsQuery.isLoading
                  ? "Memuat grup…"
                  : "Belum ada grup. Pastikan WhatsApp terhubung & ada chat grup masuk."
              }
              className="h-9 text-sm"
            />
            {groupJid && (
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Nama tampilan grup (opsional)"
              />
            )}
          </div>

          {/* Sheet credential */}
          <div className="space-y-2">
            <Label>Credential Google Sheets</Label>
            <Select
              value={sheetCredentialId != null ? String(sheetCredentialId) : ""}
              onValueChange={(v) => {
                setSheetCredentialId(Number(v));
                setSpreadsheetId("");
                setSpreadsheetUrl(null);
                setSheetTab("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pilih credential Sheets…" />
              </SelectTrigger>
              <SelectContent>
                {sheetCreds.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                    {c.accountEmail ? ` · ${c.accountEmail}` : ""}
                  </SelectItem>
                ))}
                {sheetCreds.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    Belum ada credential Sheets yang terhubung. Buat di menu Credentials.
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Spreadsheet pick/create */}
          {sheetCredentialId != null && (
            <div className="space-y-2">
              <Label>Spreadsheet</Label>
              <Select
                value={spreadsheetId}
                onValueChange={(v) => {
                  setSpreadsheetId(v);
                  const sp = spreadsheets.find((s) => s.id === v);
                  setSpreadsheetUrl(sp?.url ?? null);
                  setSheetTab("");
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      spreadsheetsQuery.isLoading ? "Memuat…" : "Pilih spreadsheet…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {spreadsheets.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Input
                  value={newSheetTitle}
                  onChange={(e) => setNewSheetTitle(e.target.value)}
                  placeholder="…atau buat spreadsheet baru (judul)"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!newSheetTitle.trim() || createSheetMut.isPending}
                  onClick={handleCreateSheet}
                >
                  {createSheetMut.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    "Buat"
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Tab */}
          {spreadsheetId && (
            <div className="space-y-2">
              <Label>Tab (sheet) tujuan</Label>
              <Select value={sheetTab} onValueChange={setSheetTab}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={tabsQuery.isLoading ? "Memuat…" : "Pilih tab…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {tabs.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Columns */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Kolom output (urutan = urutan kolom di Sheet)</Label>
              <Button type="button" size="sm" variant="ghost" onClick={addColumn}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Kolom
              </Button>
            </div>
            <div className="space-y-2">
              {columns.map((col, i) => (
                <div key={i} className="flex items-start gap-2">
                  <GripVertical className="w-4 h-4 text-muted-foreground mt-2.5 flex-shrink-0" />
                  <div className="grid grid-cols-2 gap-2 flex-1">
                    <Input
                      value={col.name}
                      onChange={(e) => setColumn(i, { name: e.target.value })}
                      placeholder="Nama kolom (mis. Total)"
                    />
                    <Input
                      value={col.hint}
                      onChange={(e) => setColumn(i, { hint: e.target.value })}
                      placeholder="Petunjuk untuk AI (opsional)"
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeColumn(i)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* AI prompt (required, per-group) */}
          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="ai-prompt">Instruksi AI (wajib)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={applyKasHarianTemplate}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                Pakai contoh: Laporan Kas Harian
              </Button>
            </div>
            <Textarea
              id="ai-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Wajib diisi — tentukan apa yang AI baca/lakukan, mis. 'Baca foto nota dan catat pemasukan/pengeluaran untuk laporan kas harian.' Gunakan tombol contoh di atas untuk mulai cepat."
            />
            <p className="text-[11px] text-muted-foreground">
              Wajib diisi: tanpa Instruksi AI, modul AI Review tidak akan memproses apa
              pun. Kolom output di atas tetap menjadi format hasilnya — AI selalu
              membalas dengan data sesuai nama kolom yang ditulis ke Google Sheet.
              Instruksi ini hanya mengubah apa yang AI baca/lakukan, bukan format
              outputnya.
            </p>
          </div>

          {/* Drive (optional) */}
          <div className="space-y-2 border-t border-border pt-4">
            <Label>Arsip foto ke Google Drive (opsional)</Label>
            <Select
              value={driveCredentialId != null ? String(driveCredentialId) : "none"}
              onValueChange={(v) => {
                if (v === "none") {
                  setDriveCredentialId(null);
                  setDriveFolderId(null);
                  setDriveFolderName(null);
                } else {
                  setDriveCredentialId(Number(v));
                  setDriveFolderId(null);
                  setDriveFolderName(null);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Tanpa arsip Drive" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Tanpa arsip Drive</SelectItem>
                {driveCreds.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                    {c.accountEmail ? ` · ${c.accountEmail}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {driveCredentialId != null && (
              <SearchableSelect
                value={driveFolderId ?? ""}
                onChange={(v) => {
                  setDriveFolderId(v);
                  const f = folders.find((x) => x.id === v);
                  setDriveFolderName(f?.name ?? null);
                }}
                options={folders.map((f) => ({ value: f.id, label: f.name }))}
                placeholder={
                  foldersQuery.isLoading ? "Memuat folder…" : "Pilih folder…"
                }
                searchPlaceholder="Ketik nama folder…"
                emptyText={
                  foldersQuery.isLoading
                    ? "Memuat folder…"
                    : "Folder tidak ditemukan."
                }
                disabled={foldersQuery.isLoading}
                testId="drive-folder-select"
              />
            )}
            {driveCredentialId != null && (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="scanner-ai-switch">Scanner AI</Label>
                  <p className="text-xs text-muted-foreground">
                    {scannerAi
                      ? "Aktif: setiap foto dideteksi notanya, dihilangkan background-nya, diluruskan & dipertajam sebelum disimpan ke Drive (seperti hasil scan)."
                      : "Nonaktif: foto disimpan apa adanya ke Drive."}
                  </p>
                </div>
                <Switch
                  id="scanner-ai-switch"
                  checked={scannerAi}
                  onCheckedChange={setScannerAi}
                  data-testid="scanner-ai-switch"
                />
              </div>
            )}
          </div>

          {/* Schedule + enabled */}
          <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
            <div className="space-y-2">
              <Label>Jam cut-off harian</Label>
              <Input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Zona waktu Asia/Jakarta (WIB).
              </p>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <div className="flex items-center gap-2 h-10">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                <span className="text-sm">{enabled ? "Aktif" : "Nonaktif"}</span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {existing ? "Simpan" : "Tambah"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
