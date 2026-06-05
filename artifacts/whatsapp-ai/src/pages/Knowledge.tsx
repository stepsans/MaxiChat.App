import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledge,
  useCreateKnowledge,
  useUpdateKnowledge,
  useDeleteKnowledge,
  getListKnowledgeQueryKey,
  useListKnowledgeTypes,
  useCreateKnowledgeType,
  useDeleteKnowledgeType,
  getListKnowledgeTypesQueryKey,
} from "@workspace/api-client-react";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Label } from "@/components/ui/label";
import { Plus, Pencil, Trash2, BookOpen, Loader2, Upload, Download, Settings2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ChannelMultiSelect } from "@/components/ChannelMultiSelect";

const TYPE_COLOR_PALETTE = [
  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "bg-pink-500/10 text-pink-400 border-pink-500/20",
  "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  "bg-teal-500/10 text-teal-400 border-teal-500/20",
];

function colorForType(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return TYPE_COLOR_PALETTE[h % TYPE_COLOR_PALETTE.length];
}

const entrySchema = z.object({
  type: z.string().min(1, "Type is required"),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  channelIds: z.array(z.number().int().positive()).default([]),
});

type EntryForm = z.infer<typeof entrySchema>;

type KnowledgeEntry = {
  id: number;
  type: string;
  title: string;
  content: string;
  channelIds: number[];
  createdAt: string;
  updatedAt: string;
};

export default function Knowledge() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<KnowledgeEntry | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [typesDialogOpen, setTypesDialogOpen] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const [deleteTypeId, setDeleteTypeId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data: entries, isLoading } = useListKnowledge();
  const { data: types } = useListKnowledgeTypes();
  const typeList = types ?? [];
  const labelForType = (value: string) =>
    typeList.find((t) => t.value === value)?.label ?? value;

  const createType = useCreateKnowledgeType({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListKnowledgeTypesQueryKey() });
        setNewTypeLabel("");
        toast({ title: "Type ditambahkan." });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : "Gagal menambah type");
        toast({ variant: "destructive", title: "Gagal", description: msg });
      },
    },
  });
  const deleteType = useDeleteKnowledgeType({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListKnowledgeTypesQueryKey() });
        setDeleteTypeId(null);
        toast({ title: "Type dihapus." });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : "Gagal menghapus type");
        setDeleteTypeId(null);
        toast({ variant: "destructive", title: "Gagal", description: msg });
      },
    },
  });

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 31);

  const handleAddType = () => {
    const label = newTypeLabel.trim();
    if (!label) return;
    const value = slugify(label);
    if (!value) {
      toast({
        variant: "destructive",
        title: "Nama tidak valid",
        description: "Gunakan huruf atau angka.",
      });
      return;
    }
    createType.mutate({ data: { value, label } });
  };
  const create = useCreateKnowledge({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
        setDialogOpen(false);
        toast({ title: "Knowledge entry added." });
      },
    },
  });
  const update = useUpdateKnowledge({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
        setDialogOpen(false);
        setEditEntry(null);
        toast({ title: "Entry updated." });
      },
    },
  });
  const remove = useDeleteKnowledge({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
        setDeleteId(null);
        toast({ title: "Entry deleted." });
      },
    },
  });
  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith(".csv") && !name.endsWith(".xlsx")) {
      toast({
        variant: "destructive",
        title: "Format tidak didukung",
        description: "Gunakan file .csv atau .xlsx",
      });
      return;
    }
    setPendingFile(f);
  };

  const runImport = async () => {
    if (!pendingFile) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const res = await fetch(`${import.meta.env.BASE_URL}api/knowledge/import`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as {
        imported?: number;
        error?: string;
      };
      if (!res.ok) {
        toast({
          variant: "destructive",
          title: "Import gagal",
          description: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
      qc.invalidateQueries({ queryKey: getListKnowledgeTypesQueryKey() });
      toast({
        title: `Import berhasil: ${json.imported ?? 0} entry.`,
        description: "Semua data lama sudah diganti.",
      });
      setPendingFile(null);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Import gagal",
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setImporting(false);
    }
  };

  const form = useForm<EntryForm>({
    resolver: zodResolver(entrySchema),
    defaultValues: { type: "product", title: "", content: "", channelIds: [] },
  });

  const openCreate = () => {
    setEditEntry(null);
    const defaultType = typeList[0]?.value ?? "product";
    form.reset({ type: defaultType, title: "", content: "", channelIds: [] });
    setDialogOpen(true);
  };

  const openEdit = (entry: KnowledgeEntry) => {
    setEditEntry(entry);
    form.reset({
      type: entry.type,
      title: entry.title,
      content: entry.content,
      channelIds: entry.channelIds ?? [],
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: EntryForm) => {
    if (editEntry) {
      update.mutate({ id: editEntry.id, data });
    } else {
      create.mutate({ data });
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Knowledge Base</h1>
          <p className="text-xs text-muted-foreground">
            {entries?.length ?? 0} entries — AI learns from this data
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="button-export-knowledge"
                size="sm"
                variant="outline"
                disabled={(entries?.length ?? 0) === 0}
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a
                  data-testid="link-export-csv"
                  href={`${import.meta.env.BASE_URL}api/knowledge/export.csv`}
                  download
                >
                  Download CSV
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  data-testid="link-export-xlsx"
                  href={`${import.meta.env.BASE_URL}api/knowledge/export.xlsx`}
                  download
                >
                  Download Excel (.xlsx)
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            data-testid="input-import-file"
            onChange={handleFilePick}
          />
          {can.mutateKnowledge && (
            <>
              <Button
                data-testid="button-import-knowledge"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Import
              </Button>
              <Button
                data-testid="button-manage-types"
                size="sm"
                variant="outline"
                onClick={() => setTypesDialogOpen(true)}
              >
                <Settings2 className="w-3.5 h-3.5 mr-1.5" />
                Kelola Type
              </Button>
              <Button data-testid="button-add-knowledge" size="sm" onClick={openCreate}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add Entry
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 p-6">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array(6)
              .fill(0)
              .map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
          </div>
        ) : entries?.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <BookOpen className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No knowledge entries yet</p>
            <p className="text-xs mt-1">Add product info, FAQs, and sales scripts</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {entries?.map((entry) => (
              <Card
                key={entry.id}
                data-testid={`knowledge-card-${entry.id}`}
                className="group relative"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant="secondary"
                        className="text-[10px] shrink-0 font-mono text-muted-foreground"
                        data-testid={`text-knowledge-id-${entry.id}`}
                      >
                        #{entry.id}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] shrink-0", colorForType(entry.type))}
                      >
                        {labelForType(entry.type)}
                      </Badge>
                      <CardTitle className="text-sm truncate">{entry.title}</CardTitle>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <Button
                        data-testid={`button-edit-knowledge-${entry.id}`}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => openEdit(entry)}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        data-testid={`button-delete-knowledge-${entry.id}`}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() => setDeleteId(entry.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                    {entry.content}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editEntry ? "Edit Entry" : "Add Knowledge Entry"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-knowledge-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {typeList.map((t) => (
                          <SelectItem key={t.id} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => setTypesDialogOpen(true)}
                        data-testid="link-manage-types"
                      >
                        <Settings2 className="w-3 h-3 mr-1" />
                        Kelola Type
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input data-testid="input-knowledge-title" placeholder="e.g. Product Description" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Content</FormLabel>
                    <FormControl>
                      <Textarea
                        data-testid="textarea-knowledge-content"
                        placeholder="Enter detailed content that the AI will use to answer questions..."
                        rows={6}
                        className="resize-none"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="channelIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Berlaku di channel</FormLabel>
                    <ChannelMultiSelect
                      value={field.value ?? []}
                      onChange={field.onChange}
                      testIdPrefix="knowledge-channels"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button data-testid="button-save-knowledge" type="submit" disabled={isPending}>
                  {isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {editEntry ? "Update" : "Add"} Entry
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Import Confirm */}
      <AlertDialog
        open={pendingFile !== null}
        onOpenChange={(open) => {
          if (!open && !importing) setPendingFile(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import & ganti seluruh Knowledge Base?</AlertDialogTitle>
            <AlertDialogDescription>
              File: <b>{pendingFile?.name}</b>
              <br />
              <br />
              Semua entry yang ada sekarang akan <b>dihapus permanen</b>, lalu diganti dengan isi
              file. Format kolom wajib: <b>type</b>, <b>title</b>, <b>content</b> (baris pertama =
              header). Tipe valid: product, faq, script, testimonial, website. Tindakan ini tidak
              bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Batal</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-import"
              onClick={(e) => {
                e.preventDefault();
                void runImport();
              }}
              disabled={importing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {importing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Ganti & Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manage Types Dialog */}
      <Dialog open={typesDialogOpen} onOpenChange={setTypesDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Kelola Type Knowledge</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                data-testid="input-new-type"
                placeholder="Nama type baru (mis. Promo)"
                value={newTypeLabel}
                onChange={(e) => setNewTypeLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddType();
                  }
                }}
                disabled={createType.isPending}
              />
              <Button
                data-testid="button-add-type"
                onClick={handleAddType}
                disabled={createType.isPending || !newTypeLabel.trim()}
              >
                {createType.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
              {typeList.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  Belum ada type.
                </p>
              ) : (
                typeList.map((t) => (
                  <div
                    key={t.id}
                    data-testid={`type-row-${t.value}`}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border border-border"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] shrink-0", colorForType(t.value))}
                      >
                        {t.label}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {t.value}
                      </span>
                    </div>
                    <Button
                      data-testid={`button-delete-type-${t.value}`}
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                      onClick={() => setDeleteTypeId(t.id)}
                      disabled={deleteType.isPending}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Type yang masih dipakai oleh entry tidak bisa dihapus. Hapus dulu entry-nya.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypesDialogOpen(false)}>
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Type Confirm */}
      <AlertDialog
        open={deleteTypeId !== null}
        onOpenChange={(open) => !open && setDeleteTypeId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus type ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Type akan dihapus dari daftar pilihan. Operasi ini akan gagal jika masih ada entry
              yang memakainya.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-type"
              onClick={() => deleteTypeId && deleteType.mutate({ id: deleteTypeId })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Entry</AlertDialogTitle>
            <AlertDialogDescription>
              This knowledge entry will be permanently deleted. The AI will no longer use this information.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-knowledge"
              onClick={() => deleteId && remove.mutate({ id: deleteId })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
