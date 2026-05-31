import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCredentials,
  useCreateCredential,
  useUpdateCredential,
  useDeleteCredential,
  useStartCredentialOauth,
  getListCredentialsQueryKey,
  useGetAiProvider,
  useUpdateAiProvider,
  useTestAiProvider,
  getGetAiProviderQueryKey,
  AiProviderName,
  type Credential,
  type CredentialType,
  type AiProviderConfig,
  type AiProviderMode,
} from "@workspace/api-client-react";
import KnowledgeSyncCard from "@/components/KnowledgeSyncCard";
import ProductSyncCard from "@/components/ProductSyncCard";
import SalesOrderSyncCard from "@/components/SalesOrderSyncCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  KeyRound,
  Plus,
  Loader2,
  Search,
  MoreVertical,
  Pencil,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Circle,
  Copy,
  ExternalLink,
  RotateCcw,
  BookOpen,
  Sparkles,
  Settings2,
} from "lucide-react";
import { SiGoogle } from "react-icons/si";

const CRED_APPS: { type: CredentialType; label: string; description: string }[] = [
  {
    type: "googleSheetsOAuth2Api",
    label: "Google Sheets OAuth2 API",
    description: "Use OAuth2 to access Google Sheets on behalf of a user.",
  },
  {
    type: "googleSheetsTriggerOAuth2Api",
    label: "Google Sheets Trigger OAuth2 API",
    description:
      "OAuth2 credential dedicated to Sheets Trigger workflows (separate token store).",
  },
];

function appLabel(t: string): string {
  return CRED_APPS.find((a) => a.type === t)?.label ?? t;
}

function StatusPill({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
        <CheckCircle2 className="w-3.5 h-3.5" /> Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="w-3.5 h-3.5" /> Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Circle className="w-3.5 h-3.5" /> Not connected
    </span>
  );
}

export default function CredentialsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editor, setEditor] = useState<
    | { mode: "create"; type: CredentialType }
    | { mode: "edit"; credential: Credential }
    | null
  >(null);
  const [deleting, setDeleting] = useState<Credential | null>(null);

  const { data, isLoading } = useListCredentials({
    query: { queryKey: getListCredentialsQueryKey() },
  });
  const credentials: Credential[] = data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return credentials;
    return credentials.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        appLabel(c.type).toLowerCase().includes(q) ||
        (c.accountEmail ?? "").toLowerCase().includes(q)
    );
  }, [credentials, search]);

  const deleteMut = useDeleteCredential({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
        toast({ title: "Credential dihapus" });
        setDeleting(null);
      },
      onError: () => toast({ title: "Gagal menghapus", variant: "destructive" }),
    },
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">Credentials</h1>
        </div>
        <Button size="sm" onClick={() => setPickerOpen(true)}>
          <Plus className="w-4 h-4 mr-1" /> Add credential
        </Button>
      </div>

      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <div className="relative max-w-md w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search credentials..."
            className="pl-9"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        <AiProviderCard />

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-16 text-muted-foreground">
            <KeyRound className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">Belum ada credential.</p>
            <p className="text-xs mt-1">
              Tambahkan credential Google untuk auto-sync produk dari Google Sheets.
            </p>
          </div>
        ) : (
          <div className="border border-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">App</th>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-border hover:bg-muted/30 cursor-pointer"
                    onClick={() => setEditor({ mode: "edit", credential: c })}
                  >
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <SiGoogle className="w-3.5 h-3.5 text-muted-foreground" />
                        {appLabel(c.type)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {c.accountEmail ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill status={c.status} />
                    </td>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setEditor({ mode: "edit", credential: c })}
                          >
                            <Pencil className="w-4 h-4 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleting(c)}
                          >
                            <Trash2 className="w-4 h-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SiGoogle className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Integrasi Google Sheets</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Atur semua sinkronisasi data ke Google Sheets di satu tempat.
          </p>
          <div className="border border-border rounded-md overflow-hidden [&>div:last-child]:border-b-0">
            <KnowledgeSyncCard />
            <ProductSyncCard />
            <SalesOrderSyncCard />
          </div>
        </div>
      </div>

      <AppPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(type) => {
          setPickerOpen(false);
          setEditor({ mode: "create", type });
        }}
      />

      {editor && (
        <CredentialEditorDialog
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
          }}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus credential?</AlertDialogTitle>
            <AlertDialogDescription>
              Workflow / sync yang memakai credential ini akan gagal. Tindakan ini tidak
              bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMut.mutate({ id: deleting.id })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const PROVIDER_META: Record<
  AiProviderName,
  { label: string; modelPlaceholder: string; baseUrlPlaceholder: string }
> = {
  [AiProviderName.openai]: {
    label: "OpenAI",
    modelPlaceholder: "gpt-4o-mini",
    baseUrlPlaceholder: "(default OpenAI endpoint)",
  },
  [AiProviderName.gemini]: {
    label: "Google Gemini",
    modelPlaceholder: "gemini-2.0-flash",
    baseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  [AiProviderName.openrouter]: {
    label: "OpenRouter",
    modelPlaceholder: "openai/gpt-4o-mini",
    baseUrlPlaceholder: "https://openrouter.ai/api/v1",
  },
};

function AiProviderCard() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useGetAiProvider({
    query: { queryKey: getGetAiProviderQueryKey() },
  });

  // The endpoint is Super-Admin-only; a 403 simply means this member can't
  // manage AI billing. Hide the card entirely for them.
  if (isError) return null;

  const cfg = data ?? null;
  const isByok = cfg?.mode === "byok";
  const providerLabel = cfg
    ? PROVIDER_META[cfg.provider].label
    : "OpenAI";

  return (
    <div className="border border-border rounded-lg p-4 flex items-center justify-between gap-4 bg-card">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">AI Provider</h2>
            {isLoading ? (
              <Skeleton className="h-4 w-16" />
            ) : isByok ? (
              <Badge variant="secondary" className="text-[10px]">
                {providerLabel} · API key sendiri
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Replit AI (default)
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-prose">
            {isByok
              ? `Balasan AI memakai API key ${providerLabel} Anda sendiri${
                  cfg?.model ? ` (model ${cfg.model})` : ""
                }. Tagihan langsung ke provider.`
              : "Balasan AI memakai layanan bawaan Replit — tanpa konfigurasi, tanpa API key. Pilih provider sendiri untuk pakai API key Anda."}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="flex-shrink-0"
        onClick={() => setOpen(true)}
        disabled={isLoading}
      >
        <Settings2 className="w-4 h-4 mr-1.5" /> Konfigurasi
      </Button>

      {open && cfg && (
        <AiProviderDialog config={cfg} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function AiProviderDialog({
  config,
  onClose,
}: {
  config: AiProviderConfig;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [mode, setMode] = useState<AiProviderMode>(config.mode);
  const [provider, setProvider] = useState<AiProviderName>(config.provider);
  const [model, setModel] = useState(config.model ?? "");
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const meta = PROVIDER_META[provider];
  const isByok = mode === "byok";

  const updateMut = useUpdateAiProvider();
  const testMut = useTestAiProvider();

  async function handleTest() {
    setTestResult(null);
    try {
      const res = await testMut.mutateAsync({
        data: {
          provider,
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      setTestResult(res);
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      setTestResult({
        ok: false,
        message: err?.data?.error || err?.message || "Gagal menguji koneksi.",
      });
    }
  }

  async function handleSave() {
    // Guard: switching to BYOK needs a key (either freshly typed or stored).
    if (isByok && !apiKey.trim() && !config.hasApiKey) {
      toast({
        title: "API key wajib diisi",
        description: "Masukkan API key provider untuk mode 'API key sendiri'.",
        variant: "destructive",
      });
      return;
    }
    try {
      await updateMut.mutateAsync({
        data: {
          mode,
          provider,
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      qc.invalidateQueries({ queryKey: getGetAiProviderQueryKey() });
      toast({ title: "Konfigurasi AI tersimpan" });
      onClose();
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      toast({
        title: "Gagal menyimpan",
        description: err?.data?.error || err?.message || "Server error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Konfigurasi AI Provider</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(v) => {
              setMode(v as AiProviderMode);
              setTestResult(null);
            }}
            className="gap-2"
          >
            <label
              className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40"
              htmlFor="ai-mode-replit"
            >
              <RadioGroupItem value="replit" id="ai-mode-replit" className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">Replit AI (default)</div>
                <div className="text-xs text-muted-foreground">
                  Layanan bawaan, tanpa konfigurasi atau API key. Direkomendasikan.
                </div>
              </div>
            </label>
            <label
              className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40"
              htmlFor="ai-mode-byok"
            >
              <RadioGroupItem value="byok" id="ai-mode-byok" className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">API key sendiri</div>
                <div className="text-xs text-muted-foreground">
                  Pakai API key OpenAI, Gemini, atau OpenRouter Anda. Tagihan
                  langsung ke provider.
                </div>
              </div>
            </label>
          </RadioGroup>

          {isByok && (
            <div className="space-y-4 border-t border-border pt-4">
              <Field label="Provider">
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    setProvider(v as AiProviderName);
                    setTestResult(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(AiProviderName).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_META[p].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="API Key"
                hint={
                  config.hasApiKey
                    ? `Tersimpan: ${config.maskedApiKey ?? "••••"}. Kosongkan untuk pakai key yang ada.`
                    : undefined
                }
              >
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config.hasApiKey ? "••••••••" : "sk-..."}
                  autoComplete="off"
                />
              </Field>

              <Field label="Model" hint="Kosongkan untuk pakai model default provider.">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={meta.modelPlaceholder}
                />
              </Field>

              <Field
                label="Base URL (opsional)"
                hint="Hanya untuk endpoint kustom / proxy."
              >
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={meta.baseUrlPlaceholder}
                />
              </Field>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testMut.isPending}
                >
                  {testMut.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Test koneksi
                </Button>
                {testResult && (
                  <span
                    className={`inline-flex items-center gap-1 text-xs ${
                      testResult.ok ? "text-emerald-500" : "text-destructive"
                    }`}
                  >
                    {testResult.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5" />
                    )}
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Batal
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={updateMut.isPending}
            >
              {updateMut.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Simpan
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (t: CredentialType) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = CRED_APPS.filter(
    (a) =>
      a.label.toLowerCase().includes(q.toLowerCase()) ||
      a.description.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add new credential</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search for app..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="max-h-72 overflow-auto -mx-1">
          {filtered.map((a) => (
            <button
              key={a.type}
              type="button"
              className="w-full text-left px-3 py-2.5 rounded-md hover:bg-muted/60 flex items-start gap-3"
              onClick={() => onPick(a.type)}
            >
              <SiGoogle className="w-5 h-5 mt-0.5 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{a.label}</div>
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {a.description}
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-xs text-muted-foreground px-3 py-6 text-center">
              No matches.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CredentialEditorDialog({
  state,
  onClose,
  onSaved,
}: {
  state:
    | { mode: "create"; type: CredentialType }
    | { mode: "edit"; credential: Credential };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isCreate = state.mode === "create";
  const existing = isCreate ? null : state.credential;
  const type = isCreate ? state.type : existing!.type;

  const [tab, setTab] = useState<"connection" | "details">("connection");
  const [guideOpen, setGuideOpen] = useState(isCreate);
  const guide = CRED_GUIDES[type];
  const [name, setName] = useState(
    existing?.name ?? appLabel(type) + " account"
  );
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  // Don't surface the stored secret. Empty input = keep existing secret on
  // edit; required on create.
  const [credentialId, setCredentialId] = useState<number | null>(
    existing?.id ?? null
  );
  const [status, setStatus] = useState(existing?.status ?? "new");
  const [accountEmail, setAccountEmail] = useState<string | null>(
    existing?.accountEmail ?? null
  );

  const redirectUrl = `${window.location.protocol}//${window.location.host}/api/credentials/oauth/callback`;

  const createMut = useCreateCredential();
  const updateMut = useUpdateCredential();
  const startMut = useStartCredentialOauth();

  // Listen for the postMessage from the OAuth callback popup so we can
  // refresh the in-dialog status without a full page reload.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const m = ev.data;
      if (m?.type !== "vjchat:oauth") return;
      if (typeof m.credentialId === "number" && m.credentialId === credentialId) {
        if (m.ok) {
          setStatus("connected");
          if (typeof m.email === "string") setAccountEmail(m.email);
          toast({ title: "Connected to Google" });
          onSaved();
        } else {
          setStatus("error");
          toast({
            title: "OAuth gagal",
            description: m.error || "Coba lagi.",
            variant: "destructive",
          });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [credentialId, toast, onSaved]);

  async function persist(): Promise<number | null> {
    if (!name.trim()) {
      toast({ title: "Nama wajib diisi", variant: "destructive" });
      return null;
    }
    if (!clientId.trim()) {
      toast({ title: "Client ID wajib diisi", variant: "destructive" });
      return null;
    }
    try {
      if (isCreate && credentialId === null) {
        if (!clientSecret.trim()) {
          toast({ title: "Client Secret wajib diisi", variant: "destructive" });
          return null;
        }
        const created = await createMut.mutateAsync({
          data: { name: name.trim(), type, clientId: clientId.trim(), clientSecret },
        });
        setCredentialId(created.id);
        setStatus(created.status);
        onSaved();
        return created.id;
      } else {
        const id = credentialId!;
        await updateMut.mutateAsync({
          id,
          data: {
            name: name.trim(),
            clientId: clientId.trim(),
            ...(clientSecret.trim() ? { clientSecret } : {}),
          },
        });
        onSaved();
        return id;
      }
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      toast({
        title: "Gagal menyimpan",
        description: err?.data?.error || err?.message || "Server error",
        variant: "destructive",
      });
      return null;
    }
  }

  async function signInWithGoogle() {
    const id = await persist();
    if (id === null) return;
    try {
      const res = await startMut.mutateAsync({ id });
      const popup = window.open(
        res.url,
        "vjchat-oauth",
        "width=520,height=640,menubar=no,toolbar=no"
      );
      if (!popup) {
        toast({
          title: "Popup diblokir",
          description: "Izinkan popup lalu coba lagi.",
          variant: "destructive",
        });
      }
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      toast({
        title: "OAuth gagal dimulai",
        description: err?.data?.error || err?.message || "Server error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <div className="flex border-b border-border px-6 py-3 items-center justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="text-base">{appLabel(type)}</DialogTitle>
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
              <StatusPill status={status} />
              {accountEmail && (
                <span className="text-muted-foreground">· {accountEmail}</span>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setGuideOpen(true)}
          >
            <BookOpen className="w-4 h-4 mr-1.5" /> Panduan
          </Button>
        </div>
        <div className="grid grid-cols-[180px_1fr] min-h-[420px]">
          <div className="border-r border-border bg-muted/20 p-2 flex flex-col gap-1">
            <TabBtn active={tab === "connection"} onClick={() => setTab("connection")}>
              Connection
            </TabBtn>
            <TabBtn active={tab === "details"} onClick={() => setTab("details")}>
              Details
            </TabBtn>
          </div>
          <div className="p-6 space-y-4 overflow-auto">
            {tab === "connection" ? (
              <>
                <Field label="OAuth Redirect URL" hint="Paste this into Google Cloud Console → Authorized redirect URIs.">
                  <div className="flex gap-2">
                    <Input value={redirectUrl} readOnly className="font-mono text-xs" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(redirectUrl);
                        toast({ title: "Disalin" });
                      }}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </Field>
                <Field label="Client ID">
                  <Input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="123-abc.apps.googleusercontent.com"
                  />
                </Field>
                <Field
                  label="Client Secret"
                  hint={
                    existing
                      ? "Kosongkan untuk pakai secret yang sudah tersimpan."
                      : undefined
                  }
                >
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={existing ? "••••••••" : ""}
                  />
                </Field>
                <div className="pt-2 flex items-center gap-3">
                  <Button
                    type="button"
                    onClick={signInWithGoogle}
                    disabled={createMut.isPending || updateMut.isPending || startMut.isPending}
                  >
                    {(createMut.isPending || updateMut.isPending || startMut.isPending) && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    {status === "connected" ? (
                      <>
                        <RotateCcw className="w-4 h-4 mr-2" /> Reconnect
                      </>
                    ) : (
                      <>
                        <SiGoogle className="w-4 h-4 mr-2" /> Sign in with Google
                      </>
                    )}
                  </Button>
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    Google Cloud Console <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="text-xs text-muted-foreground border-t border-border pt-3">
                  Scopes: <code className="font-mono">spreadsheets.readonly</code>,{" "}
                  <code className="font-mono">drive.readonly</code>
                </div>
              </>
            ) : (
              <>
                <Field label="Credential Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Type">
                  <Input value={appLabel(type)} readOnly />
                </Field>
                <div className="flex justify-end pt-2">
                  <Button
                    type="button"
                    onClick={async () => {
                      const id = await persist();
                      if (id !== null)
                        toast({ title: "Tersimpan" });
                    }}
                    disabled={createMut.isPending || updateMut.isPending}
                  >
                    {(createMut.isPending || updateMut.isPending) && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    Save
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
      <GuideDialog
        open={guideOpen}
        onOpenChange={setGuideOpen}
        guide={guide}
        title={appLabel(type)}
      />
    </Dialog>
  );
}

type CredGuide = {
  purpose: string;
  useCases: string[];
  example: string;
  steps: { title: string; body: string }[];
  docsUrl: string;
};

const SHARED_OAUTH_STEPS: { title: string; body: string }[] = [
  {
    title: "Buka Google Cloud Console",
    body: 'Masuk ke https://console.cloud.google.com. Buat project baru (atau pilih project yang sudah ada). Pastikan akun Google yang dipakai adalah akun yang memiliki spreadsheet produk Anda.',
  },
  {
    title: "Aktifkan API yang dibutuhkan",
    body: 'Di menu kiri pilih "APIs & Services" → "Library". Cari dan klik Enable untuk: (1) Google Sheets API, dan (2) Google Drive API. Drive API dipakai supaya MaxiChat bisa menampilkan daftar spreadsheet milik Anda saat memilih sumber data.',
  },
  {
    title: "Atur OAuth consent screen",
    body: 'Buka "APIs & Services" → "OAuth consent screen". Pilih User Type "External" lalu Create. Isi App name (mis. "MaxiChat"), User support email, dan Developer contact. Di tahap Scopes biarkan kosong (scope ditambahkan otomatis saat sign-in). Di tahap Test users, tambahkan alamat email Google Anda — wajib selama app masih "Testing".',
  },
  {
    title: "Buat OAuth Client ID",
    body: 'Buka "APIs & Services" → "Credentials" → "Create credentials" → "OAuth client ID". Application type: pilih "Web application". Beri nama (mis. "MaxiChat Web").',
  },
  {
    title: "Tempel Authorized redirect URI",
    body: 'Di bagian "Authorized redirect URIs", klik Add URI, lalu tempel URL OAuth Redirect URL persis seperti yang tertera di tab Connection di bawah (tombol salin sudah disediakan). Tanpa langkah ini Google akan menolak login dengan error redirect_uri_mismatch.',
  },
  {
    title: "Salin Client ID dan Client Secret",
    body: 'Setelah klik Create, Google menampilkan pop-up berisi Client ID dan Client Secret. Salin keduanya, lalu tempel ke tab Connection di kanan. Client Secret hanya muncul sekali — kalau hilang, buat OAuth client baru atau Reset secret.',
  },
  {
    title: "Klik Sign in with Google",
    body: 'Di tab Connection, klik "Sign in with Google". Popup akan terbuka, pilih akun Google, lalu klik Allow. Setelah selesai status credential berubah jadi Connected dan token disimpan terenkripsi di server.',
  },
];

const CRED_GUIDES: Record<CredentialType, CredGuide> = {
  googleSheetsOAuth2Api: {
    purpose:
      "Credential ini menghubungkan MaxiChat ke akun Google Anda agar bisa membaca isi spreadsheet — terutama untuk auto-sync katalog produk dari Google Sheets. Token disimpan terenkripsi (AES-256-GCM) di server.",
    useCases: [
      "Auto-sync katalog produk dari Google Sheets (sheet menjadi source of truth: baris hilang = produk terhapus).",
      "Sync manual sekali klik dari halaman Products.",
      "Memilih spreadsheet dan tab dari dropdown tanpa harus copy-paste ID.",
    ],
    example:
      'Anda punya spreadsheet "Katalog Toko Saya" dengan kolom Kode Product, Nama Barang, Harga Pricelist, Link Foto, dll. Tim sales mengupdate harga langsung di sheet itu. Setelah credential ini terhubung, MaxiChat menarik isi sheet tiap 5/15/30/60 menit (sesuai pilihan Anda) dan katalog di app selalu sama dengan sheet.',
    steps: SHARED_OAUTH_STEPS,
    docsUrl: "https://developers.google.com/sheets/api/quickstart/js",
  },
  googleSheetsTriggerOAuth2Api: {
    purpose:
      "Versi terpisah dari Google Sheets OAuth2 API yang ditujukan khusus untuk workflow berbasis trigger (misalnya kalau nanti MaxiChat menambah flow yang dijalankan tiap kali baris baru muncul di sheet). Token-nya disimpan di slot berbeda supaya tidak bentrok dengan credential sync produk.",
    useCases: [
      "Memisahkan token untuk flow berbasis Sheets Trigger dari token sync produk.",
      "Memakai akun Google yang berbeda untuk trigger vs sync (mis. akun ops vs akun marketing).",
      "Mengisolasi izin: kalau salah satu di-revoke, yang lain tetap jalan.",
    ],
    example:
      "Tim ops punya sheet 'Order Masuk' yang dipakai sebagai trigger membalas customer otomatis. Tim marketing punya sheet 'Katalog Produk' yang dipakai untuk sync. Pakai credential Trigger untuk akun ops, dan credential biasa untuk akun marketing — masing-masing punya scope dan riwayat login sendiri.",
    steps: SHARED_OAUTH_STEPS,
    docsUrl: "https://developers.google.com/sheets/api/quickstart/js",
  },
};

function GuideDialog({
  open,
  onOpenChange,
  guide,
  title,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  guide: CredGuide;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden flex flex-col max-h-[85vh]">
        <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
          <DialogTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-muted-foreground" />
            Panduan — {title}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 text-sm">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Tujuan & kegunaan
            </h3>
            <p className="text-foreground/90 leading-relaxed">{guide.purpose}</p>
            <ul className="list-disc pl-5 mt-3 space-y-1.5 text-foreground/80">
              {guide.useCases.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Contoh pemakaian
            </h3>
            <div className="rounded-md border border-border bg-muted/30 p-3.5 text-foreground/90 leading-relaxed">
              {guide.example}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Cara ambil Client ID & Client Secret
            </h3>
            <ol className="space-y-3.5">
              {guide.steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed mt-1">
                      {s.body}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <a
              href={guide.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-4"
            >
              Dokumentasi resmi Google <ExternalLink className="w-3 h-3" />
            </a>
          </section>
        </div>
        <div className="px-6 py-3 border-t border-border flex justify-end flex-shrink-0">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            Tutup
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-left text-sm px-3 py-2 rounded-md " +
        (active
          ? "bg-background border border-border font-medium"
          : "text-muted-foreground hover:bg-muted/60")
      }
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
