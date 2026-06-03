import { useState, type ReactNode } from "react";
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
  useGenerateAiReviewColumns,
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
  FileSpreadsheet,
  HardDrive,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

const SHEET_CRED_TYPES = ["googleSheetsOAuth2Api", "googleSheetsTriggerOAuth2Api"];

// Ready-made template for a daily cash report (Laporan Kas Harian). Applying it
// fills both the AI instruction and the matching output columns so the owner can
// start from a working setup instead of writing the prompt from scratch.
const KAS_HARIAN_TEMPLATE: { prompt: string; columns: ColumnDraft[] } = {
  prompt: `Anda adalah asisten pembukuan kas harian toko berbahasa Indonesia. Dari setiap foto nota/struk, tentukan apakah transaksi PEMASUKAN (uang masuk) atau PENGELUARAN (uang keluar), lalu ekstrak SETIAP item/baris pada nota untuk Laporan Kas Harian.

PENTING — satu baris per item:
- Jika satu nota memuat beberapa item (mis. 5 barang), buat SATU baris untuk tiap item (berarti 5 baris).
- Nilai yang berlaku untuk seluruh nota (Tanggal, No. Nota, Nama Toko/Vendor, Metode Bayar, jenis transaksi) ditulis SAMA di setiap baris.
- Nilai khusus item (Nama Item, Qty, Harga Satuan, Keterangan, dan nominal Pemasukan/Pengeluaran) diisi sesuai item baris tersebut.
- Jika nota tidak punya rincian item, cukup buat satu baris.

Aturan:
- Jenis transaksi: nota pembelian/belanja/biaya = Pengeluaran; nota penjualan/setoran/penerimaan = Pemasukan.
- "Pemasukan" diisi HANYA jika uang masuk, selain itu kosongkan. "Pengeluaran" diisi HANYA jika uang keluar, selain itu kosongkan. Isi dengan subtotal item baris itu (Qty × Harga Satuan).
- Tanggal pakai format YYYY-MM-DD sesuai yang tertera di nota; jika tidak ada, kosongkan.
- Semua nominal ditulis angka saja, tanpa "Rp", tanpa titik/koma ribuan.
- Kategori pilih yang paling sesuai: Penjualan, Pembelian Barang, Operasional, Gaji, Sewa, Listrik/Air/Internet, Transport, atau Lainnya.
- Metode bayar: Tunai atau Transfer sesuai nota; jika tidak jelas, isi "Tunai".
- Keterangan: ringkas item pada baris ini (mis. "Pulpen 1 lusin"), bukan ringkasan seluruh nota.`,
  columns: [
    { name: "Tanggal", hint: "Tanggal pada nota, format YYYY-MM-DD (sama di tiap baris nota ini)" },
    { name: "No. Nota", hint: "Nomor struk/nota bila ada (sama di tiap baris nota ini)" },
    { name: "Nama Toko/Vendor", hint: "Nama penjual/toko di nota (sama di tiap baris)" },
    { name: "Nama Item", hint: "Nama barang/jasa pada baris ini" },
    { name: "Qty", hint: "Jumlah/kuantitas item ini, angka saja" },
    { name: "Harga Satuan", hint: "Harga per unit item ini, angka saja" },
    { name: "Keterangan", hint: "Ringkasan item pada baris ini" },
    { name: "Kategori", hint: "Penjualan / Pembelian / Operasional / dll" },
    { name: "Pemasukan", hint: "Subtotal bila uang masuk, angka saja" },
    { name: "Pengeluaran", hint: "Subtotal bila uang keluar, angka saja" },
    { name: "Metode Bayar", hint: "Tunai atau Transfer" },
  ],
};

function groupShortName(jid: string): string {
  return jid.replace(/@g\.us$/, "");
}

// Numbered, bordered section used to break the config form into clear steps so
// users aren't overwhelmed by one long list of fields.
function FormSection({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {step}
        </div>
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="space-y-4 sm:pl-9">{children}</div>
    </section>
  );
}

// Small labelled divider for the two output destinations inside section 3.
function OutputSubHeader({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-foreground">
        {icon}
        <h4 className="text-xs font-semibold uppercase tracking-wide">{title}</h4>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RunStatusPill({ config }: { config: AiReviewConfig }) {
  const status = config.lastRunStatus;
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {config.lastRunCount} baris ditulis
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
            cut-off harian, AI membaca tiap nota, menulis satu baris per item ke Google
            Sheet (satu nota bisa jadi beberapa baris), dan (opsional) menyimpan fotonya
            ke folder Google Drive.
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
  const generateColumnsMut = useGenerateAiReviewColumns();
  const saving = createMut.isPending || updateMut.isPending;

  // "Generate by AI": read the Instruksi AI (section 2) and replace the output
  // columns with an AI-proposed set. Requires the instruction to be filled.
  async function handleGenerateColumns() {
    const instruction = prompt.trim();
    if (!instruction) {
      toast({
        title: "Instruksi AI kosong",
        description: "Isi Instruksi AI (langkah 2) dulu sebelum generate kolom.",
        variant: "destructive",
      });
      return;
    }
    try {
      const res = await generateColumnsMut.mutateAsync({
        data: { prompt: instruction },
      });
      setColumns(
        res.columns.map((c) => ({ name: c.name, hint: c.hint ?? "" }))
      );
      toast({
        title: "Kolom dibuat",
        description: `AI mengusulkan ${res.columns.length} kolom dari Instruksi AI. Sesuaikan bila perlu.`,
      });
    } catch {
      toast({
        title: "Gagal membuat kolom",
        description: "AI tidak dapat membuat kolom. Coba perjelas Instruksi AI.",
        variant: "destructive",
      });
    }
  }

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

  // Drag-to-reorder for output columns. Only the grip handle is draggable so the
  // text inputs stay normally selectable; the row is the drop target.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  function moveColumn(from: number, to: number) {
    if (from === to) return;
    setColumns((cols) => {
      const next = [...cols];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
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
    if (!prompt.trim())
      return "Isi Instruksi AI dulu — tanpa instruksi, AI Review tidak akan berjalan.";
    if (sheetCredentialId == null) return "Pilih credential Google Sheets.";
    if (!spreadsheetId) return "Pilih atau buat spreadsheet.";
    if (!sheetTab) return "Pilih tab (sheet) tujuan.";
    const cleaned = columns
      .map((c) => ({ name: c.name.trim(), hint: c.hint.trim() }))
      .filter((c) => c.name);
    if (cleaned.length === 0) return "Tambahkan minimal satu kolom output.";
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

        <div className="space-y-4 py-2">
          {/* Section 1: Group selection */}
          <FormSection
            step={1}
            title="Pemilihan Grup Percakapan"
            description="Pilih grup WhatsApp yang foto notanya akan direkap otomatis."
          >
            <div className="space-y-2">
              <Label>Grup WhatsApp</Label>
              <SearchableSelect
                value={
                  channelId != null && groupJid ? `${channelId}:${groupJid}` : ""
                }
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
                modalPopover
              />
              {groupJid && (
                <Input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Nama tampilan grup (opsional)"
                />
              )}
            </div>
          </FormSection>

          {/* Section 2: AI instruction */}
          <FormSection
            step={2}
            title="Instruksi AI"
            description="Tentukan apa yang AI baca & lakukan pada setiap foto. Wajib diisi."
          >
            <div className="space-y-2">
              <div className="flex items-center justify-end">
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
                aria-label="Instruksi AI"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                maxLength={4000}
                placeholder="Wajib diisi — tentukan apa yang AI baca/lakukan, mis. 'Baca foto nota dan catat pemasukan/pengeluaran untuk laporan kas harian.' Gunakan tombol contoh di atas untuk mulai cepat."
              />
              <p className="text-[11px] text-muted-foreground">
                Wajib diisi: tanpa Instruksi AI, modul AI Review tidak akan memproses
                apa pun. Kolom output (di Settingan Output) tetap menjadi format
                hasilnya — AI selalu membalas dengan data sesuai nama kolom yang
                ditulis ke Google Sheet. Instruksi ini hanya mengubah apa yang AI
                baca/lakukan, bukan format outputnya.
              </p>
            </div>
          </FormSection>

          {/* Section 3: Output settings */}
          <FormSection
            step={3}
            title="Settingan Output"
            description="Ke mana hasil rekap ditulis dan (opsional) foto diarsipkan."
          >
            {/* Output: Google Sheet */}
            <div className="space-y-4">
              <OutputSubHeader
                icon={<FileSpreadsheet className="w-4 h-4" />}
                title="Output Google Sheet"
                hint="Hasil rekap ditulis satu baris per item ke tab spreadsheet (satu nota bisa jadi beberapa baris)."
              />

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
                        Belum ada credential Sheets yang terhubung. Buat di menu
                        Credentials.
                      </div>
                    )}
                  </SelectContent>
                </Select>
              </div>

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
                          spreadsheetsQuery.isLoading
                            ? "Memuat…"
                            : "Pilih spreadsheet…"
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

              {/* Generate output columns from the Instruksi AI (section 2). */}
              <div className="rounded-md border border-dashed border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Buat kolom output otomatis: AI membaca Instruksi AI (langkah
                    2) lalu menyusun kolomnya.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!prompt.trim() || generateColumnsMut.isPending}
                    onClick={handleGenerateColumns}
                  >
                    {generateColumnsMut.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Generate by AI
                  </Button>
                </div>
              </div>

              {/* Columns (drag to reorder) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Kolom output</Label>
                  <Button type="button" size="sm" variant="ghost" onClick={addColumn}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Kolom
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Urutan kolom = urutan kolom di Sheet. Tarik ikon{" "}
                  <GripVertical className="inline w-3 h-3 align-text-bottom" /> untuk
                  mengubah urutan.
                </p>
                <div className="space-y-2">
                  {columns.map((col, i) => (
                    <div
                      key={i}
                      onDragOver={(e) => {
                        if (dragIndex !== null) e.preventDefault();
                      }}
                      onDrop={() => {
                        if (dragIndex !== null) {
                          moveColumn(dragIndex, i);
                          setDragIndex(null);
                        }
                      }}
                      className={`flex items-start gap-2 rounded-md transition-opacity ${
                        dragIndex === i ? "opacity-50" : ""
                      }`}
                    >
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          setDragIndex(i);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", String(i));
                        }}
                        onDragEnd={() => setDragIndex(null)}
                        aria-label="Tarik untuk mengubah urutan kolom"
                        className="mt-2 flex-shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="w-4 h-4" />
                      </button>
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
                      <div className="flex flex-col flex-shrink-0">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-5 w-7"
                          disabled={i === 0}
                          aria-label="Pindah kolom ke atas"
                          onClick={() => moveColumn(i, i - 1)}
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-5 w-7"
                          disabled={i === columns.length - 1}
                          aria-label="Pindah kolom ke bawah"
                          onClick={() => moveColumn(i, i + 1)}
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </Button>
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
            </div>

            {/* Output: Google Drive */}
            <div className="space-y-4 border-t border-border pt-4">
              <OutputSubHeader
                icon={<HardDrive className="w-4 h-4" />}
                title="Output Google Drive (opsional)"
                hint="Arsipkan foto nota ke folder Drive."
              />
              <div className="space-y-2">
                <Label>Folder penyimpanan</Label>
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
                    modalPopover
                  />
                )}
              </div>
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
          </FormSection>

          {/* Section 4: schedule + status */}
          <FormSection
            step={4}
            title="Cut Off Harian & Status"
            description="Kapan rekap dijalankan tiap hari, dan apakah otomatisasi aktif."
          >
            <div className="grid grid-cols-2 gap-4">
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
          </FormSection>
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
