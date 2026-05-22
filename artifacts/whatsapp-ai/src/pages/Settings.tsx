import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  useGetWhatsappBio,
  useUpdateWhatsappBio,
  getGetWhatsappBioQueryKey,
} from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Bot, Clock, MessageSquare, User } from "lucide-react";
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
      </div>
    </div>
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
