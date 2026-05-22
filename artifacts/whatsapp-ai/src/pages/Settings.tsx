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
import { Loader2, Bot, Clock, MessageSquare, User, Zap, Plus, Trash2, Pencil, X, Check } from "lucide-react";
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

const settingsSchema = z.object({
  systemPrompt: z.string().min(1, "System prompt is required"),
  autoReplyEnabled: z.boolean(),
  replyDelayMin: z.coerce.number().int().min(0).max(30),
  replyDelayMax: z.coerce.number().int().min(0).max(60),
  fallbackMessage: z.string().min(1, "Fallback message is required"),
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
      });
    }
  }, [settings, form]);

  const onSubmit = (data: SettingsForm) => {
    update.mutate({ data });
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

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="text-xs text-muted-foreground">Configure AI behavior and auto-reply</p>
        </div>
      </div>

      <div className="flex-1 p-6 max-w-2xl space-y-5">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  Auto Reply
                </CardTitle>
                <CardDescription className="text-xs">
                  Enable AI to automatically reply to incoming WhatsApp messages
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="autoReplyEnabled"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <div>
                        <FormLabel className="text-sm">Enable AI Auto Reply</FormLabel>
                        <FormDescription className="text-xs">
                          AI will respond 24/7 to all incoming messages
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" />
                  Reply Delay
                </CardTitle>
                <CardDescription className="text-xs">
                  Natural delay before AI sends a reply (makes it feel more human)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="replyDelayMin"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Min delay (seconds)</FormLabel>
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
                        <FormLabel className="text-xs">Max delay (seconds)</FormLabel>
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  AI System Prompt
                </CardTitle>
                <CardDescription className="text-xs">
                  Instructions that define how the AI behaves as a customer service agent
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
                          rows={10}
                          className="resize-none font-mono text-xs"
                          placeholder="Enter your AI system prompt..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  Fallback Message
                </CardTitle>
                <CardDescription className="text-xs">
                  Sent when AI is not confident in its answer
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
                          rows={3}
                          className="resize-none text-sm"
                          placeholder="e.g. Aku bantu cek dulu ya kak..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Button
              data-testid="button-save-settings"
              type="submit"
              disabled={update.isPending}
            >
              {update.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              Save Settings
            </Button>
          </form>
        </Form>

        <BioCard />
        <ShortcutsCard />
      </div>
    </div>
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          Shortcut / Text Expander
        </CardTitle>
        <CardDescription className="text-xs">
          Ketik kata pendek di kolom chat (mis. <code>/almt</code>) dan akan otomatis diganti dengan teks panjang. Tidak case-sensitive.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new row */}
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-start p-3 rounded-lg bg-sidebar-accent/40 border border-border">
          <Input
            data-testid="input-new-shortcut"
            value={draftShortcut}
            onChange={(e) => setDraftShortcut(e.target.value.slice(0, 64))}
            placeholder="/almt"
            className="font-mono text-sm"
          />
          <Textarea
            data-testid="textarea-new-replacement"
            value={draftReplacement}
            onChange={(e) => setDraftReplacement(e.target.value.slice(0, 4000))}
            placeholder={"Jl. Pakuwon City T12-18\nSurabaya"}
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
                  className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2 items-start p-3 rounded-lg border border-border bg-[hsl(var(--wa-panel))]"
                >
                  {isEditing ? (
                    <>
                      <Input
                        data-testid={`input-edit-shortcut-${s.id}`}
                        value={editShortcut}
                        onChange={(e) => setEditShortcut(e.target.value.slice(0, 64))}
                        className="font-mono text-sm"
                      />
                      <Textarea
                        data-testid={`textarea-edit-replacement-${s.id}`}
                        value={editReplacement}
                        onChange={(e) =>
                          setEditReplacement(e.target.value.slice(0, 4000))
                        }
                        rows={Math.min(6, Math.max(2, editReplacement.split("\n").length))}
                        className="text-sm"
                      />
                      <div className="flex gap-1 md:flex-col md:self-start">
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
