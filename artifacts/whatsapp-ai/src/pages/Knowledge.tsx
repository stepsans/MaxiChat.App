import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledge,
  useCreateKnowledge,
  useUpdateKnowledge,
  useDeleteKnowledge,
  useDeleteManualKnowledge,
  getListKnowledgeQueryKey,
} from "@workspace/api-client-react";
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
import { Plus, Pencil, Trash2, BookOpen, Loader2, Eraser } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const typeColors: Record<string, string> = {
  product: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  faq: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  script: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  testimonial: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  website: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
};

const entrySchema = z.object({
  type: z.enum(["product", "faq", "script", "testimonial", "website"]),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
});

type EntryForm = z.infer<typeof entrySchema>;

type KnowledgeEntry = {
  id: number;
  type: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export default function Knowledge() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<KnowledgeEntry | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: entries, isLoading } = useListKnowledge();
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
  const removeManual = useDeleteManualKnowledge({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
        setBulkDeleteOpen(false);
        toast({
          title: `${data.deleted} entry manual dihapus.`,
          description: "Entry dari Google Sheet tetap utuh.",
        });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Gagal menghapus entry manual",
          description: "Coba lagi atau periksa koneksi.",
        });
      },
    },
  });

  const manualCount = entries?.filter((e) => (e as { source?: string }).source === "manual").length ?? 0;

  const form = useForm<EntryForm>({
    resolver: zodResolver(entrySchema),
    defaultValues: { type: "product", title: "", content: "" },
  });

  const openCreate = () => {
    setEditEntry(null);
    form.reset({ type: "product", title: "", content: "" });
    setDialogOpen(true);
  };

  const openEdit = (entry: KnowledgeEntry) => {
    setEditEntry(entry);
    form.reset({
      type: entry.type as EntryForm["type"],
      title: entry.title,
      content: entry.content,
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
          <Button
            data-testid="button-delete-manual-knowledge"
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => setBulkDeleteOpen(true)}
            disabled={manualCount === 0}
            title={manualCount === 0 ? "Tidak ada entry manual" : undefined}
          >
            <Eraser className="w-3.5 h-3.5 mr-1.5" />
            Hapus Entry Manual ({manualCount})
          </Button>
          <Button data-testid="button-add-knowledge" size="sm" onClick={openCreate}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add Entry
          </Button>
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
                        variant="outline"
                        className={cn("text-[10px] shrink-0", typeColors[entry.type])}
                      >
                        {entry.type}
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
                        <SelectItem value="product">Product</SelectItem>
                        <SelectItem value="faq">FAQ</SelectItem>
                        <SelectItem value="script">Sales Script</SelectItem>
                        <SelectItem value="testimonial">Testimonial</SelectItem>
                        <SelectItem value="website">Website</SelectItem>
                      </SelectContent>
                    </Select>
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

      {/* Bulk Delete Manual Confirm */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus semua entry manual?</AlertDialogTitle>
            <AlertDialogDescription>
              {manualCount} entry yang dibuat manual lewat tombol "Add Entry" akan dihapus permanen.
              Entry yang berasal dari Google Sheet tetap aman dan tidak terpengaruh.
              Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-manual"
              onClick={() => removeManual.mutate()}
              disabled={removeManual.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeManual.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Hapus Semua
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
