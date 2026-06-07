import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetPaymentConfig,
  useAdminUpdatePaymentConfig,
  getAdminGetPaymentConfigQueryKey,
  type PaymentGatewayConfig,
} from "@workspace/api-client-react";
import {
  Loader2,
  RefreshCw,
  CreditCard,
  Save,
  CheckCircle2,
  XCircle,
  KeyRound,
  Webhook,
  Copy,
  Check,
  ShieldCheck,
} from "lucide-react";

function StatusPill({
  configured,
  source,
}: {
  configured: boolean;
  source?: string | null;
}) {
  if (configured) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
        <CheckCircle2 className="w-3 h-3" />
        Tersimpan{source === "env" ? " (env)" : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-400 border-amber-500/30">
      <XCircle className="w-3 h-3" />
      Belum diisi
    </span>
  );
}

function CopyField({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-xs font-mono break-all bg-input border border-border rounded-md px-2.5 py-2">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {}
          );
        }}
        data-testid={testId}
        className="h-8 px-2.5 shrink-0 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
        {copied ? "Tersalin" : "Salin"}
      </button>
    </div>
  );
}

export default function PaymentGateway() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [secretKey, setSecretKey] = useState("");
  const [callbackToken, setCallbackToken] = useState("");
  const [isActive, setIsActive] = useState(true);

  const statusQuery = useAdminGetPaymentConfig({
    query: { queryKey: getAdminGetPaymentConfigQueryKey() },
  });
  const status = statusQuery.data as PaymentGatewayConfig | undefined;

  // Keep the active toggle in sync with the server once loaded.
  useEffect(() => {
    if (status) setIsActive(status.isActive);
  }, [status?.isActive]);

  useEffect(() => {
    document.title = "MaxiChat Admin — Gateway Pembayaran";
  }, []);

  function invalidate() {
    qc.invalidateQueries({ queryKey: getAdminGetPaymentConfigQueryKey() });
  }

  const update = useAdminUpdatePaymentConfig({
    mutation: {
      onSuccess: () => {
        setSecretKey("");
        setCallbackToken("");
        setOkMsg("Konfigurasi gateway tersimpan.");
        setTimeout(() => setOkMsg(null), 2500);
        invalidate();
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal menyimpan konfigurasi"),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    update.mutate({
      data: {
        secretKey: secretKey.trim() || undefined,
        callbackToken: callbackToken.trim() || undefined,
        isActive,
      },
    });
  }

  // Webhook URL the operator pastes into the Xendit dashboard. The API is
  // served under /api by the shared proxy; the inbound webhook route is
  // /api/webhooks/xendit.
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/xendit`
      : "/api/webhooks/xendit";

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-muted-foreground" />
            Gateway Pembayaran
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
            Kredensial Xendit milik operator (satu akun untuk semua tenant).
            Secret key & callback token dienkripsi dan tidak pernah ditampilkan
            kembali. Jika kosong, sistem memakai variabel environment sebagai
            cadangan.
          </p>
        </div>
        <button
          onClick={() => statusQuery.refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-payment-config"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${
              statusQuery.isFetching ? "animate-spin" : ""
            }`}
          />
          Muat ulang
        </button>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      {okMsg && (
        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {okMsg}
        </div>
      )}

      {/* Current status */}
      <section className="border border-border rounded-lg bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
          Status saat ini
        </h2>
        {statusQuery.isLoading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat...
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="w-3.5 h-3.5" /> Secret Key
                {status?.secretKeyLast4 && (
                  <span className="font-mono text-foreground">
                    ••••{status.secretKeyLast4}
                  </span>
                )}
              </span>
              <StatusPill
                configured={!!status?.secretKeyConfigured}
                source={status?.secretKeySource}
              />
            </div>
            <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Webhook className="w-3.5 h-3.5" /> Callback Token
              </span>
              <StatusPill
                configured={!!status?.callbackTokenConfigured}
                source={status?.callbackTokenSource}
              />
            </div>
          </div>
        )}
        {status && !status.isActive && (
          <p className="text-[11px] text-amber-400">
            Gateway sedang dinonaktifkan — kredensial DB diabaikan sampai
            diaktifkan kembali.
          </p>
        )}
      </section>

      {/* Webhook URL */}
      <section className="border border-border rounded-lg bg-card p-4 space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Webhook className="w-4 h-4 text-muted-foreground" />
          URL Webhook
        </h2>
        <p className="text-xs text-muted-foreground">
          Tempelkan URL ini di dashboard Xendit (Settings → Webhooks → Invoices
          paid) dan pakai callback token yang sama di bawah.
        </p>
        <CopyField value={webhookUrl} testId="copy-webhook-url" />
      </section>

      {/* Edit form */}
      <form
        onSubmit={submit}
        className="border border-border rounded-lg bg-card p-4 space-y-4"
      >
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Save className="w-4 h-4 text-muted-foreground" />
          Ubah kredensial
        </h2>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Xendit Secret Key
          </span>
          <input
            type="password"
            autoComplete="off"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={
              status?.secretKeyConfigured
                ? "•••• (biarkan kosong untuk tidak mengubah)"
                : "xnd_production_... atau xnd_development_..."
            }
            data-testid="input-secret-key"
            className="h-9 px-2.5 rounded-md border border-border bg-input text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Webhook className="w-3.5 h-3.5" /> Xendit Callback Token
          </span>
          <input
            type="password"
            autoComplete="off"
            value={callbackToken}
            onChange={(e) => setCallbackToken(e.target.value)}
            placeholder={
              status?.callbackTokenConfigured
                ? "•••• (biarkan kosong untuk tidak mengubah)"
                : "Verification token dari dashboard Xendit"
            }
            data-testid="input-callback-token"
            className="h-9 px-2.5 rounded-md border border-border bg-input text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            data-testid="toggle-active"
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-xs text-foreground">
            Aktifkan gateway (pakai kredensial yang tersimpan di DB)
          </span>
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={update.isPending}
            data-testid="save-payment-config"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
          >
            {update.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Simpan
          </button>
          <p className="text-[11px] text-muted-foreground">
            Kolom yang dibiarkan kosong tidak akan mengubah nilai tersimpan.
          </p>
        </div>
      </form>
    </div>
  );
}
