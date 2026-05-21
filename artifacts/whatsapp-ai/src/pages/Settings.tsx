import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useUpdateSettings,
  useSyncKnowledgeFromGoogleSheet,
  useSyncProductsFromGoogleSheet,
  getGetSettingsQueryKey,
  getListKnowledgeQueryKey,
  getListProductsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Bot, Clock, MessageSquare, FileSpreadsheet, RefreshCw, CheckCircle2, AlertCircle, Package } from "lucide-react";
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
  googleSheetCsvUrl: z.string().optional(),
  productSheetCsvUrl: z.string().optional(),
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
      googleSheetCsvUrl: "",
      productSheetCsvUrl: "",
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
        googleSheetCsvUrl: settings.googleSheetCsvUrl ?? "",
        productSheetCsvUrl: settings.productSheetCsvUrl ?? "",
      });
    }
  }, [settings, form]);

  const onSubmit = (data: SettingsForm) => {
    update.mutate({
      data: {
        ...data,
        googleSheetCsvUrl: data.googleSheetCsvUrl?.trim() ? data.googleSheetCsvUrl.trim() : null,
        productSheetCsvUrl: data.productSheetCsvUrl?.trim() ? data.productSheetCsvUrl.trim() : null,
      },
    });
  };

  const sync = useSyncKnowledgeFromGoogleSheet({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
        if (result.success) {
          toast({ title: `Berhasil sync ${result.count} entri dari Google Sheet.` });
        } else {
          toast({
            title: "Sync gagal",
            description: result.error ?? "Unknown error",
            variant: "destructive",
          });
        }
      },
      onError: (err: unknown) => {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Gagal sync. Cek URL & akses sheet.";
        toast({ title: "Sync gagal", description: msg, variant: "destructive" });
      },
    },
  });

  const handleSyncNow = () => {
    const url = form.getValues("googleSheetCsvUrl")?.trim();
    if (!url) {
      toast({
        title: "Isi dulu Google Sheet URL",
        description: "Lalu klik Save Settings sebelum sync.",
        variant: "destructive",
      });
      return;
    }
    if (url !== (settings?.googleSheetCsvUrl ?? "")) {
      toast({
        title: "Save dulu sebelum sync",
        description: "URL berubah — klik Save Settings dulu, baru sync.",
        variant: "destructive",
      });
      return;
    }
    sync.mutate();
  };

  const productSync = useSyncProductsFromGoogleSheet({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getListProductsQueryKey() });
        if (result.success) {
          toast({ title: `Berhasil sync ${result.count} produk dari Google Sheet.` });
        } else {
          toast({
            title: "Sync produk gagal",
            description: result.error ?? "Unknown error",
            variant: "destructive",
          });
        }
      },
      onError: (err: unknown) => {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Gagal sync. Cek URL & akses sheet.";
        toast({ title: "Sync produk gagal", description: msg, variant: "destructive" });
      },
    },
  });

  const handleSyncProducts = () => {
    const url = form.getValues("productSheetCsvUrl")?.trim();
    if (!url) {
      toast({
        title: "Isi dulu Google Sheet URL produk",
        description: "Lalu klik Save Settings sebelum sync.",
        variant: "destructive",
      });
      return;
    }
    if (url !== (settings?.productSheetCsvUrl ?? "")) {
      toast({
        title: "Save dulu sebelum sync",
        description: "URL berubah — klik Save Settings dulu, baru sync.",
        variant: "destructive",
      });
      return;
    }
    productSync.mutate();
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
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="text-xs text-muted-foreground">Configure AI behavior and auto-reply</p>
        </div>
      </div>

      <div className="flex-1 p-6 max-w-2xl space-y-5">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* Auto Reply Toggle */}
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

            {/* Reply Delay */}
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

            {/* System Prompt */}
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

            {/* Fallback Message */}
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

            {/* Google Sheet Sync — Knowledge Base */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-primary" />
                  Sync Knowledge Base dari Google Sheet
                </CardTitle>
                <CardDescription className="text-xs">
                  Paste link Google Sheet (sheet harus di-share "Anyone with the link" atau Publish to web sebagai CSV). Format kolom:{" "}
                  <b>A = type</b> (product/faq/script/testimonial/website), <b>B = title</b>, <b>C = content</b>. Baris pertama = header.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <FormField
                  control={form.control}
                  name="googleSheetCsvUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Google Sheet URL</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-google-sheet-url"
                          placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Sync akan <b>mengganti semua entri sebelumnya</b> yang berasal dari sheet. Entri manual tidak terhapus.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="button-sync-google-sheet"
                    onClick={handleSyncNow}
                    disabled={sync.isPending}
                  >
                    {sync.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Sync Sekarang
                  </Button>

                  {settings?.googleSheetLastSyncAt && (
                    <div className="text-xs flex items-center gap-1.5">
                      {settings.googleSheetLastSyncError ? (
                        <>
                          <AlertCircle className="w-3.5 h-3.5 text-destructive" />
                          <span className="text-destructive">
                            {settings.googleSheetLastSyncError}
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                          <span className="text-muted-foreground">
                            Last sync:{" "}
                            {new Date(settings.googleSheetLastSyncAt).toLocaleString("id-ID")}
                            {" · "}
                            {settings.googleSheetLastSyncCount ?? 0} entri
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Google Sheet Sync — Products */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="w-4 h-4 text-primary" />
                  Sync Produk dari Google Sheet
                </CardTitle>
                <CardDescription className="text-xs">
                  Paste link Google Sheet (sheet harus di-share "Anyone with the link" atau Publish to web sebagai CSV). Urutan kolom:{" "}
                  <b>A = kode barang</b>, <b>B = nama produk</b> (opsional), <b>C = harga</b> (angka, "Rp 1.250.000" boleh),{" "}
                  <b>D = foto produk</b> (URL gambar), <b>E = link website</b>. Baris pertama = header.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <FormField
                  control={form.control}
                  name="productSheetCsvUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Google Sheet URL Produk</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-product-sheet-url"
                          placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Sync akan <b>mengganti semua produk hasil sync sebelumnya</b>. Produk yang ditambah manual lewat halaman Products tidak ikut terhapus.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="button-sync-product-sheet"
                    onClick={handleSyncProducts}
                    disabled={productSync.isPending}
                  >
                    {productSync.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Sync Sekarang
                  </Button>

                  {settings?.productSheetLastSyncAt && (
                    <div className="text-xs flex items-center gap-1.5">
                      {settings.productSheetLastSyncError &&
                      (settings.productSheetLastSyncCount ?? 0) === 0 ? (
                        <>
                          <AlertCircle className="w-3.5 h-3.5 text-destructive" />
                          <span className="text-destructive">
                            {settings.productSheetLastSyncError}
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                          <span className="text-muted-foreground">
                            Last sync:{" "}
                            {new Date(settings.productSheetLastSyncAt).toLocaleString("id-ID")}
                            {" · "}
                            {settings.productSheetLastSyncCount ?? 0} produk
                            {settings.productSheetLastSyncError
                              ? ` · ${settings.productSheetLastSyncError}`
                              : ""}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
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
      </div>
    </div>
  );
}
