import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useGetSettings,
  useUpdateGeneralSettings,
  useUpdateAutoReply,
  useRestorePreviousPrompt,
  getGetSettingsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Bot, Clock, MessageSquare, Lock, Sparkles, ShieldCheck, Undo2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";

const COOLDOWN_OPTIONS = [5, 15, 30, 60, 120] as const;

// Business-wide ("general") AI settings — only super admins may edit these.
// Auto-reply is per-channel and lives in its own card outside this form.
const generalSchema = z.object({
  systemPrompt: z.string().min(1, "System prompt is required"),
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

type GeneralForm = z.infer<typeof generalSchema>;

export default function AIStudio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isSuperAdmin, menus, isLoading: permLoading } = usePermissions();
  // canView gates the whole page (matrix aiStudio.view). Only super admins can
  // edit the business-wide general settings; permitted non-owners see them
  // read-only.
  const canView = menus.aiStudio.canView;
  const canEditGeneral = isSuperAdmin;
  const { data: settings, isLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey(), enabled: canView },
  });

  const update = useUpdateGeneralSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Pengaturan AI disimpan." });
      },
    },
  });

  const restorePrev = useRestorePreviousPrompt({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Versi sebelumnya dikembalikan." });
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal mengembalikan versi",
          description: err instanceof Error ? err.message : "Tidak ada versi sebelumnya.",
          variant: "destructive",
        });
      },
    },
  });

  const autoReply = useUpdateAutoReply({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Auto reply diperbarui." });
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal memperbarui auto reply",
          description:
            err instanceof Error ? err.message : "WhatsApp belum terhubung?",
          variant: "destructive",
        });
      },
    },
  });

  const form = useForm<GeneralForm>({
    resolver: zodResolver(generalSchema),
    defaultValues: {
      systemPrompt: "",
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
        replyDelayMin: settings.replyDelayMin,
        replyDelayMax: settings.replyDelayMax,
        fallbackMessage: settings.fallbackMessage,
        flowCooldownMinutes: settings.flowCooldownMinutes,
      });
    }
  }, [settings, form]);

  const onSubmit = (data: GeneralForm) => {
    // Defense in depth: ignore submissions from anyone without edit rights,
    // covering non-button submit paths (Enter key, programmatic submit).
    if (!canEditGeneral) return;
    // OpenAPI restricts flowCooldownMinutes to a literal union; the form
    // already validates this against COOLDOWN_OPTIONS so the cast is safe.
    update.mutate({
      data: data as unknown as Parameters<typeof update.mutate>[0]["data"],
    });
  };

  if (isLoading || permLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // Route is unguarded — self-guard so a user without aiStudio.view who
  // navigates here directly gets a clear message instead of read-only blanks.
  if (!canView) {
    return (
      <div className="p-6">
        <div className="max-w-md mx-auto mt-20 text-center space-y-3">
          <Sparkles className="w-10 h-10 mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">AI Studio</h1>
          <p className="text-sm text-muted-foreground">
            Anda tidak memiliki izin untuk mengakses AI Studio.
          </p>
        </div>
      </div>
    );
  }

  const isDirty = form.formState.isDirty;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Sticky header with Save button anchored to the right — keeps it
          reachable while scrolling. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">AI Studio</h1>
          <p className="text-xs text-muted-foreground truncate">
            Konfigurasi perilaku AI: auto-reply, jeda, cooldown, fallback, dan
            system prompt
          </p>
        </div>
        {canEditGeneral && (
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="hidden sm:inline text-xs text-muted-foreground">
                Ada perubahan belum disimpan
              </span>
            )}
            <Button
              data-testid="button-save-ai-studio"
              type="submit"
              form="ai-studio-form"
              size="sm"
              disabled={update.isPending || !isDirty}
            >
              {update.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              Simpan
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-5">
        {/* Auto reply — per-channel, editable by everyone. Saves immediately
            on toggle via its own endpoint (no need for super admin). */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              Auto Reply
            </CardTitle>
            <CardDescription className="text-xs">
              Aktifkan AI untuk membalas pesan masuk secara otomatis di nomor ini
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Aktifkan AI Auto Reply</p>
                <p className="text-xs text-muted-foreground">
                  AI akan menjawab 24/7 semua pesan yang masuk
                </p>
              </div>
              <div className="flex items-center gap-2">
                {autoReply.isPending && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                )}
                <Switch
                  data-testid="switch-auto-reply"
                  checked={settings?.autoReplyEnabled ?? true}
                  disabled={autoReply.isPending}
                  onCheckedChange={(checked) =>
                    autoReply.mutate({ data: { autoReplyEnabled: checked } })
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Form {...form}>
          <form
            id="ai-studio-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid grid-cols-1 lg:grid-cols-2 gap-5"
          >
            {!canEditGeneral && (
              <div className="lg:col-span-2 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <Lock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Pengaturan AI ini berlaku untuk seluruh bisnis. Hanya Super
                  Admin yang dapat mengubahnya — Anda hanya dapat melihatnya.
                </p>
              </div>
            )}

            {/* Reply delay — Jeda Batasan */}
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
                            disabled={!canEditGeneral}
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
                            disabled={!canEditGeneral}
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

            {/* Cooldown Flow Chatbot */}
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
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          value={String(field.value ?? 5)}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                          disabled={!canEditGeneral}
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

            {/* Fallback message */}
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
                          disabled={!canEditGeneral}
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
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Bot className="w-4 h-4 text-primary" />
                      AI System Prompt
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Instruksi yang menentukan bagaimana AI berperilaku sebagai customer service
                    </CardDescription>
                  </div>
                  {canEditGeneral && settings?.hasPreviousPrompt && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      disabled={restorePrev.isPending}
                      onClick={() => restorePrev.mutate()}
                      data-testid="button-restore-prompt"
                    >
                      {restorePrev.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Undo2 className="w-3.5 h-3.5" />
                      )}
                      Kembalikan versi sebelumnya
                    </Button>
                  )}
                </div>
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
                          disabled={!canEditGeneral}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Read-only Lapis C — the locked guardrails, always active at runtime. */}
            {settings?.hardGuardrails && (
              <Card className="lg:col-span-2 border-primary/20 bg-muted/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-primary" />
                    Aturan keamanan bawaan
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <Lock className="w-3 h-3" /> tidak bisa diubah
                    </span>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Aturan ini selalu ditambahkan otomatis ke setiap balasan AI (auto-reply, Flow, follow-up). Kamu tidak perlu menulisnya di prompt — dan tidak bisa menghapusnya.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground" data-testid="text-hard-guardrails">
                    {settings.hardGuardrails}
                  </pre>
                </CardContent>
              </Card>
            )}
          </form>
        </Form>
      </div>
    </div>
  );
}
