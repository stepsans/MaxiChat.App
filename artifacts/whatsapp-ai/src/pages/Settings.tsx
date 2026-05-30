import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWhatsappBio,
  useUpdateWhatsappBio,
  getGetWhatsappBioQueryKey,
  useListShortcuts,
  useCreateShortcut,
  useUpdateShortcut,
  useDeleteShortcut,
  getListShortcutsQueryKey,
  useListCustomerLabels,
  useCreateCustomerLabel,
  useUpdateCustomerLabel,
  useDeleteCustomerLabel,
} from "@workspace/api-client-react";
import type { TextShortcut, CustomerLabel } from "@workspace/api-client-react";
import { ChannelMultiSelect } from "@/components/ChannelMultiSelect";
import ShortcutSyncCard from "@/components/ShortcutSyncCard";
import { usePermissions } from "@/hooks/use-permissions";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, User, Zap, Plus, Trash2, Pencil, X, Check, Download, Upload, Palette, Sun, Moon, Monitor, Tag } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import * as XLSX from "xlsx";
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export default function Settings() {
  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Pengaturan</h1>
          <p className="text-xs text-muted-foreground truncate">
            Tampilan, bio WhatsApp, dan shortcut teks
          </p>
        </div>
      </div>

      <div className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-5">
        {/* Cards di luar form — punya tombol save sendiri */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <ThemeCard />
          <BioCard />
        </div>
        <ShortcutsCard />
        <LabelsCard />
      </div>
    </div>
  );
}

const LABEL_PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
  "#111827",
];

function LabelsCard() {
  const { isSuperAdmin } = usePermissions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const labelsKey = ["/api/customer-labels"];
  const { data: labels, isLoading } = useListCustomerLabels({
    query: { queryKey: labelsKey },
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_PRESET_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(LABEL_PRESET_COLORS[0]);

  const invalidate = () => qc.invalidateQueries({ queryKey: labelsKey });
  const onErr = (err: any) =>
    toast({
      title: "Gagal",
      description: err?.data?.error ?? err?.message ?? "Coba lagi.",
      variant: "destructive",
    });

  const createMut = useCreateCustomerLabel({
    mutation: {
      onSuccess: () => {
        setName("");
        setColor(LABEL_PRESET_COLORS[0]);
        invalidate();
      },
      onError: onErr,
    },
  });
  const updateMut = useUpdateCustomerLabel({
    mutation: {
      onSuccess: () => {
        setEditingId(null);
        invalidate();
      },
      onError: onErr,
    },
  });
  const deleteMut = useDeleteCustomerLabel({
    mutation: { onSuccess: invalidate, onError: onErr },
  });

  if (!isSuperAdmin) return null;

  function startEdit(l: CustomerLabel) {
    setEditingId(l.id);
    setEditName(l.name);
    setEditColor(l.color);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Tag className="w-4 h-4 text-primary" />
          Label Customer
        </CardTitle>
        <CardDescription className="text-xs">
          Buat label berwarna untuk menandai kontak. Bisa dipakai banyak label
          per kontak dari panel info chat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create form */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[160px] space-y-1">
            <label className="text-[11px] text-muted-foreground">Nama label</label>
            <Input
              data-testid="input-new-label-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="mis. High Risk Cust"
              className="h-9 text-sm"
            />
          </div>
          <ColorPicker value={color} onChange={setColor} testid="new" />
          <Button
            type="button"
            size="sm"
            data-testid="button-create-label"
            disabled={!name.trim() || createMut.isPending}
            onClick={() =>
              createMut.mutate({ data: { name: name.trim(), color } })
            }
          >
            {createMut.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Tambah
          </Button>
        </div>

        {/* List */}
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !labels || labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">Belum ada label.</p>
        ) : (
          <div className="space-y-2">
            {labels.map((l) =>
              editingId === l.id ? (
                <div
                  key={l.id}
                  className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2"
                >
                  <div className="flex-1 min-w-[140px] space-y-1">
                    <Input
                      data-testid={`input-edit-label-${l.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <ColorPicker
                    value={editColor}
                    onChange={setEditColor}
                    testid={`edit-${l.id}`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`button-save-label-${l.id}`}
                    disabled={!editName.trim() || updateMut.isPending}
                    onClick={() =>
                      updateMut.mutate({
                        id: l.id,
                        data: { name: editName.trim(), color: editColor },
                      })
                    }
                  >
                    <Check className="w-4 h-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`button-cancel-label-${l.id}`}
                    onClick={() => setEditingId(null)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <div
                  key={l.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                  data-testid={`row-label-${l.id}`}
                >
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: l.color, color: "#fff" }}
                  >
                    {l.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {l.color}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`button-edit-label-${l.id}`}
                      onClick={() => startEdit(l)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`button-delete-label-${l.id}`}
                      disabled={deleteMut.isPending}
                      onClick={() => deleteMut.mutate({ id: l.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ColorPicker({
  value,
  onChange,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <div className="flex items-center gap-1" data-testid={`colorpicker-${testid}`}>
      {LABEL_PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Warna ${c}`}
          data-testid={`color-${testid}-${c}`}
          onClick={() => onChange(c)}
          className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
          style={{
            backgroundColor: c,
            borderColor: value === c ? "hsl(var(--foreground))" : "transparent",
          }}
        />
      ))}
    </div>
  );
}

function ThemeCard() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Palette className="w-4 h-4 text-primary" />
          Tampilan
        </CardTitle>
        <CardDescription className="text-xs">
          Pilih tema warna aplikasi. "System" mengikuti pengaturan perangkat Anda.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          role="radiogroup"
          aria-label="Tema tampilan"
          className="grid grid-cols-3 gap-2"
        >
          {options.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`theme-option-${value}`}
                onClick={() => setTheme(value)}
                className={
                  "flex flex-col items-center justify-center gap-1.5 rounded-md border px-3 py-3 text-xs transition-colors " +
                  (active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background hover:bg-accent text-muted-foreground hover:text-foreground")
                }
              >
                <Icon className="w-4 h-4" />
                <span className="font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ShortcutsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListShortcuts({
    query: { queryKey: getListShortcutsQueryKey() },
  });
  const shortcuts = (data ?? []) as TextShortcut[];

  const [draftShortcut, setDraftShortcut] = useState("");
  const [draftReplacement, setDraftReplacement] = useState("");
  const [draftLink, setDraftLink] = useState("");
  const [draftChannelIds, setDraftChannelIds] = useState<number[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editShortcut, setEditShortcut] = useState("");
  const [editReplacement, setEditReplacement] = useState("");
  const [editLink, setEditLink] = useState("");
  const [editChannelIds, setEditChannelIds] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListShortcutsQueryKey() });

  const onErr = (label: string) => (err: unknown) =>
    toast({
      title: label,
      description: err instanceof Error ? err.message : "Coba lagi.",
      variant: "destructive",
    });

  const create = useCreateShortcut({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDraftShortcut("");
        setDraftReplacement("");
        setDraftLink("");
        setDraftChannelIds([]);
        toast({ title: "Shortcut ditambahkan." });
      },
      onError: onErr("Gagal menambahkan shortcut"),
    },
  });
  const update = useUpdateShortcut({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditingId(null);
        toast({ title: "Shortcut diperbarui." });
      },
      onError: onErr("Gagal memperbarui shortcut"),
    },
  });
  const remove = useDeleteShortcut({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Shortcut dihapus." });
      },
      onError: onErr("Gagal menghapus shortcut"),
    },
  });

  function normaliseShortcut(raw: string): string {
    const t = raw.trim();
    if (!t) return t;
    return t.startsWith("/") ? t : "/" + t;
  }

  function startEdit(s: TextShortcut) {
    setEditingId(s.id);
    setEditShortcut(s.shortcut);
    setEditReplacement(s.replacement);
    setEditLink(s.link ?? "");
    setEditChannelIds(s.channelIds ?? []);
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const header = ["shortcut", "replacement"];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      header.join(","),
      ...shortcuts.map((s) => [escape(s.shortcut), escape(s.replacement)].join(",")),
    ];
    // Prepend UTF-8 BOM so Excel opens non-ASCII characters correctly.
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    triggerDownload(blob, "shortcuts.csv");
  }

  function exportXlsx() {
    const ws = XLSX.utils.json_to_sheet(
      shortcuts.map((s) => ({ shortcut: s.shortcut, replacement: s.replacement }))
    );
    ws["!cols"] = [{ wch: 16 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Shortcuts");
    const arr = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    triggerDownload(
      new Blob([arr], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "shortcuts.xlsx"
    );
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error("File kosong");
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        defval: "",
      });
      // Accept either lowercase or capitalised headers.
      const pick = (r: Record<string, unknown>, ...keys: string[]) => {
        for (const k of keys) {
          const v = r[k];
          if (typeof v === "string" && v.trim()) return v;
          if (typeof v === "number") return String(v);
        }
        return "";
      };
      let added = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      for (const row of rows) {
        const rawSc = pick(row, "shortcut", "Shortcut", "SHORTCUT");
        const rawRep = pick(row, "replacement", "Replacement", "REPLACEMENT");
        const sc = normaliseShortcut(rawSc);
        const rep = rawRep.trimEnd();
        if (!sc || !rep) {
          skipped++;
          continue;
        }
        const existing = shortcuts.find(
          (s) => s.shortcut.toLowerCase() === sc.toLowerCase()
        );
        try {
          if (existing) {
            await update.mutateAsync({
              id: existing.id,
              data: { shortcut: sc, replacement: rep },
            });
            updated++;
          } else {
            await create.mutateAsync({ data: { shortcut: sc, replacement: rep } });
            added++;
          }
        } catch {
          failed++;
        }
      }
      await invalidate();
      toast({
        title: "Import selesai",
        description: `${added} ditambah, ${updated} diperbarui${
          skipped ? `, ${skipped} dilewati` : ""
        }${failed ? `, ${failed} gagal` : ""}.`,
      });
    } catch (err) {
      toast({
        title: "Gagal import file",
        description: err instanceof Error ? err.message : "File tidak valid.",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <Card>
      <ShortcutSyncCard />
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Shortcut / Text Expander
            </CardTitle>
            <CardDescription className="text-xs">
              Ketik kata pendek di kolom chat (mis. <code>/hi</code>) dan akan otomatis diganti dengan teks panjang. Tidak case-sensitive.
            </CardDescription>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportFile(f);
              }}
            />
            <Button
              data-testid="button-import-shortcuts"
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              Import
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  data-testid="button-export-shortcuts"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={shortcuts.length === 0}
                >
                  <Download className="w-3.5 h-3.5" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid="menu-export-csv"
                  onClick={exportCsv}
                >
                  CSV (.csv)
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="menu-export-xlsx"
                  onClick={exportXlsx}
                >
                  Excel (.xlsx)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new row */}
        <div className="p-3 rounded-lg bg-sidebar-accent/40 border border-border space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-start">
            <Input
              data-testid="input-new-shortcut"
              value={draftShortcut}
              onChange={(e) => setDraftShortcut(e.target.value.slice(0, 64))}
              placeholder="/hi"
              className="font-mono text-sm"
            />
            <div className="space-y-2">
              <Textarea
                data-testid="textarea-new-replacement"
                value={draftReplacement}
                onChange={(e) => setDraftReplacement(e.target.value.slice(0, 4000))}
                placeholder={"hello, nice to know you"}
                rows={2}
                className="text-sm"
              />
              <Input
                data-testid="input-new-link"
                value={draftLink}
                onChange={(e) => setDraftLink(e.target.value.slice(0, 2000))}
                placeholder="Link gambar (opsional) — dikirim sebagai foto"
                className="text-xs"
              />
            </div>
            <Button
              data-testid="button-add-shortcut"
              size="sm"
              onClick={() => {
                const sc = normaliseShortcut(draftShortcut);
                const rep = draftReplacement.trimEnd();
                if (!sc || !rep) return;
                const lk = draftLink.trim();
                create.mutate({
                  data: {
                    shortcut: sc,
                    replacement: rep,
                    link: lk ? lk : null,
                    channelIds: draftChannelIds,
                  },
                });
              }}
              disabled={
                create.isPending || !draftShortcut.trim() || !draftReplacement.trim()
              }
              className="md:self-start gap-1.5"
            >
              {create.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              Tambah
            </Button>
          </div>
          <div className="md:max-w-md">
            <ChannelMultiSelect
              value={draftChannelIds}
              onChange={setDraftChannelIds}
              testIdPrefix="new-shortcut-channels"
            />
          </div>
        </div>

        {/* Existing rows */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat...
          </div>
        ) : shortcuts.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            Belum ada shortcut. Tambahkan di atas.
          </p>
        ) : (
          <ul className="space-y-2">
            {shortcuts.map((s) => {
              const isEditing = editingId === s.id;
              return (
                <li
                  key={s.id}
                  data-testid={`shortcut-row-${s.id}`}
                  className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-stretch p-3 rounded-lg border border-border bg-[hsl(var(--wa-panel))]"
                >
                  {isEditing ? (
                    <>
                      <Input
                        data-testid={`input-edit-shortcut-${s.id}`}
                        value={editShortcut}
                        onChange={(e) => setEditShortcut(e.target.value.slice(0, 64))}
                        className="font-mono text-sm h-full"
                      />
                      <div className="space-y-2">
                        <Textarea
                          data-testid={`textarea-edit-replacement-${s.id}`}
                          value={editReplacement}
                          onChange={(e) =>
                            setEditReplacement(e.target.value.slice(0, 4000))
                          }
                          rows={Math.min(6, Math.max(2, editReplacement.split("\n").length))}
                          className="text-sm min-h-10"
                        />
                        <Input
                          data-testid={`input-edit-link-${s.id}`}
                          value={editLink}
                          onChange={(e) => setEditLink(e.target.value.slice(0, 2000))}
                          placeholder="Link gambar (opsional) — dikirim sebagai foto"
                          className="text-xs"
                        />
                        <ChannelMultiSelect
                          value={editChannelIds}
                          onChange={setEditChannelIds}
                          testIdPrefix={`edit-shortcut-channels-${s.id}`}
                        />
                      </div>
                      <div className="flex gap-1 md:flex-col md:self-stretch">
                        <Button
                          data-testid={`button-save-shortcut-${s.id}`}
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            const sc = normaliseShortcut(editShortcut);
                            const rep = editReplacement.trimEnd();
                            if (!sc || !rep) return;
                            const lk = editLink.trim();
                            update.mutate({
                              id: s.id,
                              data: {
                                shortcut: sc,
                                replacement: rep,
                                link: lk ? lk : null,
                                channelIds: editChannelIds,
                              },
                            });
                          }}
                          disabled={update.isPending}
                          className="text-primary"
                        >
                          {update.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                        </Button>
                        <Button
                          data-testid={`button-cancel-edit-${s.id}`}
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <code className="font-mono text-sm bg-background/60 px-2 py-1.5 rounded h-fit">
                        {s.shortcut}
                      </code>
                      <pre className="text-sm text-foreground whitespace-pre-wrap font-sans break-words m-0">
                        {s.replacement}
                      </pre>
                      <div className="flex gap-1 md:flex-col md:self-start">
                        <Button
                          data-testid={`button-edit-shortcut-${s.id}`}
                          size="icon"
                          variant="ghost"
                          onClick={() => startEdit(s)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          data-testid={`button-delete-shortcut-${s.id}`}
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Hapus shortcut ${s.shortcut}?`)) {
                              remove.mutate({ id: s.id });
                            }
                          }}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BioCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetWhatsappBio({
    query: { queryKey: getGetWhatsappBioQueryKey(), retry: false },
  });
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? data?.bio ?? "";

  const update = useUpdateWhatsappBio({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetWhatsappBioQueryKey() });
        toast({ title: "Bio diperbarui." });
        setDraft(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal memperbarui bio",
          description: err instanceof Error ? err.message : "WhatsApp belum terhubung?",
          variant: "destructive",
        });
      },
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <User className="w-4 h-4 text-primary" />
          Bio / About WhatsApp
        </CardTitle>
        <CardDescription className="text-xs">
          Teks singkat yang muncul di profil WhatsApp Anda (maks 139 karakter).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <>
            <Input
              data-testid="input-bio"
              value={value}
              onChange={(e) => setDraft(e.target.value.slice(0, 139))}
              placeholder="Hey there! I am using WhatsApp"
              maxLength={139}
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{value.length}/139</span>
              <Button
                data-testid="button-save-bio"
                size="sm"
                onClick={() => update.mutate({ data: { bio: value.trim() } })}
                disabled={
                  update.isPending ||
                  !value.trim() ||
                  value.trim() === (data?.bio ?? "").trim()
                }
              >
                {update.isPending && (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                )}
                Simpan Bio
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
