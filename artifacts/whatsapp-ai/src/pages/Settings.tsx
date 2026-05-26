import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useGetWhatsappBio,
  useUpdateWhatsappBio,
  getGetWhatsappBioQueryKey,
  useListShortcuts,
  useCreateShortcut,
  useUpdateShortcut,
  useDeleteShortcut,
  getListShortcutsQueryKey,
} from "@workspace/api-client-react";
import type { TextShortcut } from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Bot, Clock, MessageSquare, User, Zap, Plus, Trash2, Pencil, X, Check, Download, Upload, Palette, Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import * as XLSX from "xlsx";
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";

const COOLDOWN_OPTIONS = [5, 15, 30, 60, 120] as const;

const settingsSchema = z.object({
  systemPrompt: z.string().min(1, "System prompt is required"),
  autoReplyEnabled: z.boolean(),
  replyDelayMin: z.coerce.number().int().min(0).max(30),
  replyDelayMax: z.coerce.number().int().min(0).max(60),
  fallbackMessage: z.string().min(1, "Fallback message is required"),
  flowCooldownMinutes: z.coerce
    .number()
    .int()
    .refine((v) => (COOLDOWN_OPTIONS as readonly number[]).includes(v), {
      message: "Pilih 5, 15, 30, 60, atau 120 menit",
    }),
});

type SettingsForm = z.infer<typeof settingsSchema>;

export default function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSettings();

  const update = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Settings saved." });
      },
    },
  });

  const form = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      systemPrompt: "",
      autoReplyEnabled: true,
      replyDelayMin: 1,
      replyDelayMax: 3,
      fallbackMessage: "",
      flowCooldownMinutes: 5,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        systemPrompt: settings.systemPrompt,
        autoReplyEnabled: settings.autoReplyEnabled,
        replyDelayMin: settings.replyDelayMin,
        replyDelayMax: settings.replyDelayMax,
        fallbackMessage: settings.fallbackMessage,
        flowCooldownMinutes: settings.flowCooldownMinutes,
      });
    }
  }, [settings, form]);

  const onSubmit = (data: SettingsForm) => {
    // OpenAPI restricts flowCooldownMinutes to a literal union; the form
    // already validates this against COOLDOWN_OPTIONS so the cast is safe.
    update.mutate({ data: data as unknown as Parameters<typeof update.mutate>[0]["data"] });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const isDirty = form.formState.isDirty;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Sticky header with Save button anchored to the right — solves the
          "tombol save di tengah" problem and keeps it reachable while scrolling. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Pengaturan</h1>
          <p className="text-xs text-muted-foreground truncate">
            Konfigurasi perilaku AI, auto-reply, dan tampilan
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="hidden sm:inline text-xs text-muted-foreground">
              Ada perubahan belum disimpan
            </span>
          )}
          <Button
            data-testid="button-save-settings"
            type="submit"
            form="settings-form"
            size="sm"
            disabled={update.isPending || !isDirty}
          >
            {update.isPending && (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            )}
            Simpan
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-5">
        <Form {...form}>
          <form
            id="settings-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid grid-cols-1 lg:grid-cols-2 gap-5"
          >
            {/* Auto reply — compact, kiri atas */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  Auto Reply
                </CardTitle>
                <CardDescription className="text-xs">
                  Aktifkan AI untuk membalas pesan WhatsApp masuk secara otomatis
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="autoReplyEnabled"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <div>
                        <FormLabel className="text-sm">Aktifkan AI Auto Reply</FormLabel>
                        <FormDescription className="text-xs">
                          AI akan menjawab 24/7 semua pesan yang masuk
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          data-testid="switch-auto-reply"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Reply delay — sebelah kanan */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" />
                  Jeda Balasan
                </CardTitle>
                <CardDescription className="text-xs">
                  Delay alami sebelum AI mengirim balasan supaya terasa lebih manusiawi
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="replyDelayMin"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Min delay (detik)</FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-delay-min"
                            type="number"
                            min={0}
                            max={30}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="replyDelayMax"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Max delay (detik)</FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-delay-max"
                            type="number"
                            min={0}
                            max={60}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Cooldown — kiri bawah */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" />
                  Cooldown Flow Chatbot
                </CardTitle>
                <CardDescription className="text-xs">
                  Setelah flow chatbot selesai (End / dead-end / jawaban tidak dikenal),
                  Trigger Default di-mute selama durasi ini supaya AI bisa menjawab
                  pertanyaan lanjutan. Keyword Trigger tetap aktif. Setelah waktu habis,
                  state chat reset dan flow bisa mulai dari awal.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="flowCooldownMinutes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Durasi cooldown</FormLabel>
                      <FormControl>
                        <select
                          data-testid="select-flow-cooldown"
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                          value={String(field.value ?? 5)}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                        >
                          {COOLDOWN_OPTIONS.map((m) => (
                            <option key={m} value={m}>
                              {m} menit
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Fallback message — sebelah cooldown */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  Pesan Fallback
                </CardTitle>
                <CardDescription className="text-xs">
                  Dikirim ketika AI tidak yakin dengan jawabannya
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="fallbackMessage"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-fallback-message"
                          rows={4}
                          className="resize-none text-sm"
                          placeholder="cth. Aku bantu cek dulu ya kak..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* System prompt — selalu lebar penuh (textarea besar) */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  AI System Prompt
                </CardTitle>
                <CardDescription className="text-xs">
                  Instruksi yang menentukan bagaimana AI berperilaku sebagai customer service
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="systemPrompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-system-prompt"
                          rows={12}
                          className="resize-y font-mono text-xs"
                          placeholder="Tulis system prompt AI Anda di sini..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
          </form>
        </Form>

        {/* Cards di luar form — punya tombol save sendiri */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <ThemeCard />
          <BioCard />
        </div>
        <ShortcutsCard />
      </div>
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editShortcut, setEditShortcut] = useState("");
  const [editReplacement, setEditReplacement] = useState("");
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
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-start p-3 rounded-lg bg-sidebar-accent/40 border border-border">
          <Input
            data-testid="input-new-shortcut"
            value={draftShortcut}
            onChange={(e) => setDraftShortcut(e.target.value.slice(0, 64))}
            placeholder="/hi"
            className="font-mono text-sm"
          />
          <Textarea
            data-testid="textarea-new-replacement"
            value={draftReplacement}
            onChange={(e) => setDraftReplacement(e.target.value.slice(0, 4000))}
            placeholder={"hello, nice to know you"}
            rows={2}
            className="text-sm"
          />
          <Button
            data-testid="button-add-shortcut"
            size="sm"
            onClick={() => {
              const sc = normaliseShortcut(draftShortcut);
              const rep = draftReplacement.trimEnd();
              if (!sc || !rep) return;
              create.mutate({ data: { shortcut: sc, replacement: rep } });
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
                      <Textarea
                        data-testid={`textarea-edit-replacement-${s.id}`}
                        value={editReplacement}
                        onChange={(e) =>
                          setEditReplacement(e.target.value.slice(0, 4000))
                        }
                        rows={Math.min(6, Math.max(2, editReplacement.split("\n").length))}
                        className="text-sm min-h-10"
                      />
                      <div className="flex gap-1 md:flex-col md:self-stretch">
                        <Button
                          data-testid={`button-save-shortcut-${s.id}`}
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            const sc = normaliseShortcut(editShortcut);
                            const rep = editReplacement.trimEnd();
                            if (!sc || !rep) return;
                            update.mutate({
                              id: s.id,
                              data: { shortcut: sc, replacement: rep },
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
