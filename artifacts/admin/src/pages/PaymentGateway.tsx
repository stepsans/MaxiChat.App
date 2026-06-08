import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetPaymentConfig,
  useAdminUpdatePaymentConfig,
  getAdminGetPaymentConfigQueryKey,
  useAdminGetPaymentMethod,
  useAdminUpdatePaymentMethod,
  getAdminGetPaymentMethodQueryKey,
  useListCredentials,
  useCreateCredential,
  useStartCredentialOauth,
  useListCredentialSpreadsheets,
  useListCredentialSpreadsheetTabs,
  getListCredentialsQueryKey,
  getListCredentialSpreadsheetsQueryKey,
  getListCredentialSpreadsheetTabsQueryKey,
  useAdminGetTaxConfig,
  useAdminUpdateTaxConfig,
  getAdminGetTaxConfigQueryKey,
  useAdminGetStorageConfig,
  useAdminUpdateStorageConfig,
  getAdminGetStorageConfigQueryKey,
  useAdminGetOverageRates,
  useAdminUpdateOverageRates,
  getAdminGetOverageRatesQueryKey,
  useAdminGetDunningSettings,
  useAdminUpdateDunningSettings,
  getAdminGetDunningSettingsQueryKey,
  useAdminGetFinops,
  getAdminGetFinopsQueryKey,
  type PaymentGatewayConfig,
  type PaymentMethodSettings,
  type Credential,
  type TaxConfig,
  type StorageConfig,
  type OverageRates,
  type DunningSettings,
  type FinopsSummary,
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
  Landmark,
  Banknote,
  Table2,
  Link2,
  Percent,
  HardDrive,
  Gauge,
  Bell,
  BarChart3,
} from "lucide-react";
import { SiGoogle } from "react-icons/si";

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

const inputCls =
  "h-9 px-2.5 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40";

// --- Manual bank-transfer + verification Google Sheet config -------------
function ManualConfigSection({
  status,
  onError,
  onOk,
}: {
  status: PaymentMethodSettings | undefined;
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const qc = useQueryClient();

  const [bankName, setBankName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountHolder, setBankAccountHolder] = useState("");
  const [manualInstructions, setManualInstructions] = useState("");
  const [credentialId, setCredentialId] = useState<number | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetTab, setSheetTab] = useState("");

  // Hydrate the draft from the server once loaded.
  useEffect(() => {
    if (!status) return;
    setBankName(status.bankName ?? "");
    setBankAccountNumber(status.bankAccountNumber ?? "");
    setBankAccountHolder(status.bankAccountHolder ?? "");
    setManualInstructions(status.manualInstructions ?? "");
    setCredentialId(status.verificationCredentialId ?? null);
    setSpreadsheetId(status.verificationSpreadsheetId ?? "");
    setSheetTab(status.verificationSheetTab ?? "");
  }, [
    status?.bankName,
    status?.bankAccountNumber,
    status?.bankAccountHolder,
    status?.manualInstructions,
    status?.verificationCredentialId,
    status?.verificationSpreadsheetId,
    status?.verificationSheetTab,
  ]);

  const { data: credResp } = useListCredentials();
  const credentials: Credential[] = useMemo(
    () =>
      (credResp ?? []).filter(
        (c) =>
          c.type === "googleSheetsOAuth2Api" ||
          c.type === "googleSheetsTriggerOAuth2Api"
      ),
    [credResp]
  );
  const selectedCred = credentials.find((c) => c.id === credentialId) ?? null;
  const credReady = !!selectedCred && selectedCred.status === "connected";

  const { data: sheets, isFetching: sheetsLoading } =
    useListCredentialSpreadsheets(credentialId ?? 0, {
      query: {
        queryKey: getListCredentialSpreadsheetsQueryKey(credentialId ?? 0),
        enabled: !!credentialId && credReady,
      },
    });
  const { data: tabs, isFetching: tabsLoading } =
    useListCredentialSpreadsheetTabs(credentialId ?? 0, spreadsheetId, {
      query: {
        queryKey: getListCredentialSpreadsheetTabsQueryKey(
          credentialId ?? 0,
          spreadsheetId
        ),
        enabled: !!credentialId && credReady && !!spreadsheetId,
      },
    });

  // --- Inline Google connect (create credential + OAuth popup) -----------
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const createCred = useCreateCredential();
  const startOauth = useStartCredentialOauth();
  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}/api/credentials/oauth/callback`
      : "";

  // Refresh credential list when the OAuth popup reports success.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const m = ev.data;
      if (m?.type !== "vjchat:oauth") return;
      qc.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
      if (m.ok) {
        if (typeof m.credentialId === "number") setCredentialId(m.credentialId);
        onOk("Akun Google terhubung.");
      } else {
        onError(m.error || "OAuth gagal");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [qc, onOk, onError]);

  async function connectGoogle() {
    onError("");
    if (!clientId.trim() || !clientSecret.trim()) {
      onError("Client ID dan Client Secret wajib diisi untuk menghubungkan Google.");
      return;
    }
    try {
      const created = await createCred.mutateAsync({
        data: {
          name: "MaxiChat verifikasi pembayaran",
          type: "googleSheetsOAuth2Api",
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        },
      });
      setCredentialId(created.id);
      const res = await startOauth.mutateAsync({ id: created.id });
      window.open(
        res.url,
        "vjchat-oauth",
        "width=520,height=640,menubar=no,toolbar=no"
      );
      setClientSecret("");
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      onError(err?.data?.error || err?.message || "Gagal menghubungkan Google");
    }
  }

  async function reconnect(id: number) {
    try {
      const res = await startOauth.mutateAsync({ id });
      window.open(
        res.url,
        "vjchat-oauth",
        "width=520,height=640,menubar=no,toolbar=no"
      );
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; message?: string };
      onError(err?.data?.error || err?.message || "Gagal menghubungkan ulang");
    }
  }

  const save = useAdminUpdatePaymentMethod({
    mutation: {
      onSuccess: () => {
        onOk("Konfigurasi pembayaran manual tersimpan.");
        qc.invalidateQueries({ queryKey: getAdminGetPaymentMethodQueryKey() });
      },
      onError: (err: any) =>
        onError(err?.data?.error ?? "Gagal menyimpan konfigurasi manual"),
    },
  });

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    const selectedName =
      sheets?.find((s) => s.id === spreadsheetId)?.name ?? null;
    save.mutate({
      data: {
        bankName: bankName.trim() || null,
        bankAccountNumber: bankAccountNumber.trim() || null,
        bankAccountHolder: bankAccountHolder.trim() || null,
        manualInstructions: manualInstructions.trim() || null,
        verificationCredentialId: credentialId,
        verificationSpreadsheetId: spreadsheetId || null,
        verificationSpreadsheetName: selectedName,
        verificationSheetTab: sheetTab || null,
      },
    });
  }

  return (
    <form
      onSubmit={submitManual}
      className="border border-border rounded-lg bg-card p-4 space-y-5"
    >
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Banknote className="w-4 h-4 text-muted-foreground" />
          Rekening tujuan transfer
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Ditampilkan ke pelanggan saat checkout manual. Bukan data rahasia.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Nama Bank</span>
          <input
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="BCA / Mandiri / BRI"
            data-testid="input-bank-name"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">No. Rekening</span>
          <input
            value={bankAccountNumber}
            onChange={(e) => setBankAccountNumber(e.target.value)}
            placeholder="1234567890"
            data-testid="input-bank-account"
            className={`${inputCls} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[11px] text-muted-foreground">
            Nama Pemilik Rekening
          </span>
          <input
            value={bankAccountHolder}
            onChange={(e) => setBankAccountHolder(e.target.value)}
            placeholder="PT Maxi Chat Indonesia"
            data-testid="input-bank-holder"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[11px] text-muted-foreground">
            Instruksi tambahan (opsional)
          </span>
          <textarea
            value={manualInstructions}
            onChange={(e) => setManualInstructions(e.target.value)}
            placeholder="Contoh: cantumkan Kode Pembayaran pada berita transfer."
            data-testid="input-manual-instructions"
            rows={2}
            className="px-2.5 py-2 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40 resize-y"
          />
        </label>
      </div>

      {/* Verification Google Sheet */}
      <div className="border-t border-border pt-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Table2 className="w-4 h-4 text-muted-foreground" />
            Sheet verifikasi (mode Otomatis)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Setiap pesanan manual otomatis ditulis ke Sheet ini. Ubah kolom{" "}
            <span className="font-medium text-foreground">Status</span> menjadi{" "}
            <span className="font-mono text-emerald-400">LUNAS</span> untuk
            mengaktifkan langganan pelanggan (dicek tiap menit).
          </p>
        </div>

        {/* Credential picker / connect */}
        {credentials.length === 0 ? (
          <div className="border border-border rounded-md p-3 space-y-3 bg-muted/30">
            <p className="text-xs text-muted-foreground">
              Hubungkan satu akun Google (milik operator) untuk menulis ke
              Spreadsheet. Buat OAuth Client di Google Cloud Console, lalu
              tambahkan redirect URI berikut:
            </p>
            <CopyField value={redirectUrl} testId="copy-oauth-redirect" />
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">
                  Google Client ID
                </span>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxxx.apps.googleusercontent.com"
                  data-testid="input-google-client-id"
                  className={`${inputCls} font-mono`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">
                  Google Client Secret
                </span>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-..."
                  data-testid="input-google-client-secret"
                  className={`${inputCls} font-mono`}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={connectGoogle}
              disabled={createCred.isPending || startOauth.isPending}
              data-testid="connect-google"
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
            >
              {createCred.isPending || startOauth.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <SiGoogle className="w-4 h-4" />
              )}
              Hubungkan Google
            </button>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">
                Akun Google
              </span>
              <select
                value={credentialId ?? ""}
                onChange={(e) => {
                  setCredentialId(e.target.value ? Number(e.target.value) : null);
                  setSpreadsheetId("");
                  setSheetTab("");
                }}
                data-testid="select-credential"
                className={inputCls}
              >
                <option value="">— Pilih akun —</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.accountEmail ? ` (${c.accountEmail})` : ""} —{" "}
                    {c.status === "connected" ? "terhubung" : "belum terhubung"}
                  </option>
                ))}
              </select>
            </label>

            {selectedCred && !credReady && (
              <button
                type="button"
                onClick={() => reconnect(selectedCred.id)}
                data-testid="reconnect-google"
                className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
              >
                <Link2 className="w-3.5 h-3.5" />
                Hubungkan ulang akun ini
              </button>
            )}

            {credReady && (
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    Spreadsheet
                    {sheetsLoading && (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    )}
                  </span>
                  <select
                    value={spreadsheetId}
                    onChange={(e) => {
                      setSpreadsheetId(e.target.value);
                      setSheetTab("");
                    }}
                    data-testid="select-spreadsheet"
                    className={inputCls}
                  >
                    <option value="">— Pilih spreadsheet —</option>
                    {(sheets ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    Tab / Sheet
                    {tabsLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  </span>
                  <select
                    value={sheetTab}
                    onChange={(e) => setSheetTab(e.target.value)}
                    disabled={!spreadsheetId}
                    data-testid="select-tab"
                    className={`${inputCls} disabled:opacity-50`}
                  >
                    <option value="">— Pilih tab —</option>
                    {(tabs ?? []).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        )}

        {/* Column guide */}
        <div className="text-[11px] text-muted-foreground border border-border rounded-md p-3 bg-muted/20">
          <p className="font-medium text-foreground mb-1">
            Kolom yang akan ditulis (baris 1 = header otomatis):
          </p>
          <code className="block font-mono text-[10px] leading-relaxed break-words">
            Kode Pembayaran | Tanggal | Nama Tenant | Email | Item | Jumlah (Rp)
            | Status | Catatan
          </code>
          <p className="mt-1.5">
            Cukup ubah kolom <span className="font-medium">Status</span> ke{" "}
            <span className="font-mono">LUNAS</span>. Kolom lain jangan diubah.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={save.isPending}
          data-testid="save-manual-config"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan konfigurasi manual
        </button>
        {status && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-2">
            <StatusPill configured={status.manualBankConfigured} /> Rekening
            <StatusPill configured={status.verificationConfigured} /> Sheet
          </span>
        )}
      </div>
    </form>
  );
}

// --- Tax (PPN) configuration --------------------------------------------
function TaxConfigSection({
  onError,
  onOk,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const qc = useQueryClient();
  const taxQuery = useAdminGetTaxConfig({
    query: { queryKey: getAdminGetTaxConfigQueryKey() },
  });
  const tax = taxQuery.data as TaxConfig | undefined;

  const [enabled, setEnabled] = useState(false);
  const [ratePct, setRatePct] = useState("11");
  const [inclusive, setInclusive] = useState(true);
  const [label, setLabel] = useState("PPN");

  useEffect(() => {
    if (!tax) return;
    setEnabled(tax.enabled);
    setRatePct(String(tax.rateBps / 100));
    setInclusive(tax.inclusive);
    setLabel(tax.label);
  }, [tax?.enabled, tax?.rateBps, tax?.inclusive, tax?.label]);

  const save = useAdminUpdateTaxConfig({
    mutation: {
      onSuccess: () => {
        onOk("Konfigurasi pajak tersimpan.");
        qc.invalidateQueries({ queryKey: getAdminGetTaxConfigQueryKey() });
      },
      onError: (err: any) =>
        onError(err?.data?.error ?? "Gagal menyimpan konfigurasi pajak"),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    // Percent → basis points (whole integer). 11 → 1100. Reject malformed input.
    const pct = Number(ratePct.replace(",", "."));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      onError("Tarif pajak harus antara 0 dan 100 persen.");
      return;
    }
    const rateBps = Math.round(pct * 100);
    save.mutate({
      data: { enabled, rateBps, inclusive, label: label.trim() || "PPN" },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded-lg bg-card p-4 space-y-4"
    >
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Percent className="w-4 h-4 text-muted-foreground" />
          Pajak (PPN)
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Berlaku untuk semua invoice. Nonaktif = invoice tanpa pajak (perilaku
          default). Tarif dikunci saat invoice diterbitkan, jadi perubahan tidak
          mengubah invoice lama.
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="toggle-tax-enabled"
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-xs text-foreground">Aktifkan pajak (PPN)</span>
      </label>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Tarif (%)</span>
          <input
            value={ratePct}
            onChange={(e) => setRatePct(e.target.value)}
            inputMode="decimal"
            placeholder="11"
            disabled={!enabled}
            data-testid="input-tax-rate"
            className={`${inputCls} disabled:opacity-50`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="PPN"
            disabled={!enabled}
            data-testid="input-tax-label"
            className={`${inputCls} disabled:opacity-50`}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Metode</span>
        <select
          value={inclusive ? "inclusive" : "exclusive"}
          onChange={(e) => setInclusive(e.target.value === "inclusive")}
          disabled={!enabled}
          data-testid="select-tax-mode"
          className={`${inputCls} disabled:opacity-50`}
        >
          <option value="inclusive">
            Termasuk dalam harga (total tetap, pajak dipecah)
          </option>
          <option value="exclusive">
            Ditambahkan di atas harga (hanya tagihan bulanan)
          </option>
        </select>
      </label>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={save.isPending}
          data-testid="save-tax-config"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan pajak
        </button>
        {tax && (
          <StatusPill configured={tax.enabled && tax.rateBps > 0} />
        )}
      </div>
    </form>
  );
}

function StorageEnforcementSection({
  onError,
  onOk,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const qc = useQueryClient();
  const storageQuery = useAdminGetStorageConfig({
    query: { queryKey: getAdminGetStorageConfigQueryKey() },
  });
  const storage = storageQuery.data as StorageConfig | undefined;

  const [enabled, setEnabled] = useState(false);
  const [gracePercent, setGracePercent] = useState("0");
  const [warnPercent, setWarnPercent] = useState("80");

  useEffect(() => {
    if (!storage) return;
    setEnabled(storage.enforcementEnabled);
    setGracePercent(String(storage.gracePercent));
    setWarnPercent(String(storage.warnPercent));
  }, [storage?.enforcementEnabled, storage?.gracePercent, storage?.warnPercent]);

  const save = useAdminUpdateStorageConfig({
    mutation: {
      onSuccess: () => {
        onOk("Konfigurasi penyimpanan tersimpan.");
        qc.invalidateQueries({ queryKey: getAdminGetStorageConfigQueryKey() });
      },
      onError: (err: any) =>
        onError(err?.data?.error ?? "Gagal menyimpan konfigurasi penyimpanan"),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    const grace = Number(gracePercent.replace(",", "."));
    if (!Number.isInteger(grace) || grace < 0 || grace > 1000) {
      onError("Kelonggaran (grace) harus bilangan bulat antara 0 dan 1000 persen.");
      return;
    }
    const warn = Number(warnPercent.replace(",", "."));
    if (!Number.isInteger(warn) || warn < 1 || warn > 100) {
      onError("Ambang peringatan harus bilangan bulat antara 1 dan 100 persen.");
      return;
    }
    save.mutate({
      data: { enforcementEnabled: enabled, gracePercent: grace, warnPercent: warn },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded-lg bg-card p-4 space-y-4"
    >
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <HardDrive className="w-4 h-4 text-muted-foreground" />
          Penyimpanan Media
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Nonaktif = unggahan tidak pernah diblokir (perilaku default). Aktif =
          unggahan tenant yang melebihi kuota penyimpanan ditolak. Media masuk
          dari WhatsApp tidak pernah diblokir.
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="toggle-storage-enforcement"
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-xs text-foreground">
          Aktifkan pembatasan penyimpanan
        </span>
      </label>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Kelonggaran / grace (%)
          </span>
          <input
            value={gracePercent}
            onChange={(e) => setGracePercent(e.target.value)}
            inputMode="numeric"
            placeholder="0"
            disabled={!enabled}
            data-testid="input-storage-grace"
            className={`${inputCls} disabled:opacity-50`}
          />
          <span className="text-[10px] text-muted-foreground">
            Kelebihan di atas kuota sebelum diblokir. 0 = blokir tepat di batas.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Ambang peringatan (%)
          </span>
          <input
            value={warnPercent}
            onChange={(e) => setWarnPercent(e.target.value)}
            inputMode="numeric"
            placeholder="80"
            data-testid="input-storage-warn"
            className={inputCls}
          />
          <span className="text-[10px] text-muted-foreground">
            Dashboard tenant menampilkan peringatan "hampir penuh" di persen ini.
          </span>
        </label>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={save.isPending}
          data-testid="save-storage-config"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan penyimpanan
        </button>
        {storage && <StatusPill configured={storage.enforcementEnabled} />}
      </div>
    </form>
  );
}

function OverageRatesSection({
  onError,
  onOk,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const qc = useQueryClient();
  const query = useAdminGetOverageRates({
    query: { queryKey: getAdminGetOverageRatesQueryKey() },
  });
  const rates = query.data as OverageRates | undefined;

  const [enabled, setEnabled] = useState(false);
  const [tokenUnit, setTokenUnit] = useState("100");
  const [tokenUnitPrice, setTokenUnitPrice] = useState("0");
  const [storageGbDayPrice, setStorageGbDayPrice] = useState("0");

  useEffect(() => {
    if (!rates) return;
    setEnabled(rates.enabled);
    setTokenUnit(String(rates.tokenUnit));
    setTokenUnitPrice(String(rates.tokenUnitPriceIdr));
    setStorageGbDayPrice(String(rates.storageGbDayPriceIdr));
  }, [
    rates?.enabled,
    rates?.tokenUnit,
    rates?.tokenUnitPriceIdr,
    rates?.storageGbDayPriceIdr,
  ]);

  const save = useAdminUpdateOverageRates({
    mutation: {
      onSuccess: () => {
        onOk("Tarif kelebihan pemakaian tersimpan.");
        qc.invalidateQueries({ queryKey: getAdminGetOverageRatesQueryKey() });
      },
      onError: (err: any) =>
        onError(err?.data?.error ?? "Gagal menyimpan tarif kelebihan pemakaian"),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    const unit = Number(tokenUnit.replace(",", "."));
    const unitPrice = Number(tokenUnitPrice.replace(",", "."));
    const gbDay = Number(storageGbDayPrice.replace(",", "."));
    if (!Number.isInteger(unit) || unit < 1) {
      onError("Ukuran blok token harus bilangan bulat ≥ 1.");
      return;
    }
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      onError("Harga per blok token harus bilangan bulat Rupiah ≥ 0.");
      return;
    }
    if (!Number.isInteger(gbDay) || gbDay < 0) {
      onError("Harga penyimpanan per GB-hari harus bilangan bulat Rupiah ≥ 0.");
      return;
    }
    save.mutate({
      data: {
        enabled,
        tokenUnit: unit,
        tokenUnitPriceIdr: unitPrice,
        storageGbDayPriceIdr: gbDay,
      },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded-lg bg-card p-4 space-y-4"
    >
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Gauge className="w-4 h-4 text-muted-foreground" />
          Kelebihan Pemakaian (Overage)
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Nonaktif = pemakaian di atas kuota tidak ditagih (perilaku default).
          Aktif = penutupan bulanan menambahkan baris tagihan untuk token AI dan
          penyimpanan rata-rata yang melebihi plafon.
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="toggle-overage"
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-xs text-foreground">
          Aktifkan penagihan kelebihan pemakaian
        </span>
      </label>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Ukuran blok token
          </span>
          <input
            value={tokenUnit}
            onChange={(e) => setTokenUnit(e.target.value)}
            inputMode="numeric"
            placeholder="100"
            disabled={!enabled}
            data-testid="input-overage-token-unit"
            className={`${inputCls} disabled:opacity-50`}
          />
          <span className="text-[10px] text-muted-foreground">
            Jumlah token per satu unit tagihan.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Harga / blok token (Rp)
          </span>
          <input
            value={tokenUnitPrice}
            onChange={(e) => setTokenUnitPrice(e.target.value)}
            inputMode="numeric"
            placeholder="0"
            disabled={!enabled}
            data-testid="input-overage-token-price"
            className={`${inputCls} disabled:opacity-50`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Harga / GB-hari (Rp)
          </span>
          <input
            value={storageGbDayPrice}
            onChange={(e) => setStorageGbDayPrice(e.target.value)}
            inputMode="numeric"
            placeholder="0"
            disabled={!enabled}
            data-testid="input-overage-storage-price"
            className={`${inputCls} disabled:opacity-50`}
          />
          <span className="text-[10px] text-muted-foreground">
            Penyimpanan rata-rata harian di atas plafon.
          </span>
        </label>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={save.isPending}
          data-testid="save-overage-rates"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan tarif
        </button>
        {rates && <StatusPill configured={rates.enabled} />}
      </div>
    </form>
  );
}

function DunningSettingsSection({
  onError,
  onOk,
}: {
  onError: (m: string) => void;
  onOk: (m: string) => void;
}) {
  const qc = useQueryClient();
  const query = useAdminGetDunningSettings({
    query: { queryKey: getAdminGetDunningSettingsQueryKey() },
  });
  const settings = query.data as DunningSettings | undefined;

  const [enabled, setEnabled] = useState(false);
  const [reminder0, setReminder0] = useState("0");
  const [reminder3, setReminder3] = useState("3");
  const [reminder7, setReminder7] = useState("7");
  const [suspend, setSuspend] = useState("14");
  const [terminate, setTerminate] = useState("30");

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setReminder0(String(settings.reminder0Days));
    setReminder3(String(settings.reminder3Days));
    setReminder7(String(settings.reminder7Days));
    setSuspend(String(settings.suspendDays));
    setTerminate(String(settings.terminateDays));
  }, [
    settings?.enabled,
    settings?.reminder0Days,
    settings?.reminder3Days,
    settings?.reminder7Days,
    settings?.suspendDays,
    settings?.terminateDays,
  ]);

  const save = useAdminUpdateDunningSettings({
    mutation: {
      onSuccess: () => {
        onOk("Kebijakan penagihan tertunggak tersimpan.");
        qc.invalidateQueries({ queryKey: getAdminGetDunningSettingsQueryKey() });
      },
      onError: (err: any) =>
        onError(err?.data?.error ?? "Gagal menyimpan kebijakan penagihan"),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    const fields = [
      ["reminder0Days", reminder0],
      ["reminder3Days", reminder3],
      ["reminder7Days", reminder7],
      ["suspendDays", suspend],
      ["terminateDays", terminate],
    ] as const;
    const parsed: Record<string, number> = {};
    for (const [key, raw] of fields) {
      const n = Number(raw.replace(",", "."));
      if (!Number.isInteger(n) || n < 0) {
        onError("Semua hari harus bilangan bulat ≥ 0.");
        return;
      }
      parsed[key] = n;
    }
    save.mutate({
      data: {
        enabled,
        reminder0Days: parsed.reminder0Days,
        reminder3Days: parsed.reminder3Days,
        reminder7Days: parsed.reminder7Days,
        suspendDays: parsed.suspendDays,
        terminateDays: parsed.terminateDays,
      },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded-lg bg-card p-4 space-y-4"
    >
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Bell className="w-4 h-4 text-muted-foreground" />
          Penagihan Tertunggak (Dunning)
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Nonaktif = tenant tidak pernah ditangguhkan otomatis (perilaku
          default). Aktif = invoice yang lewat jatuh tempo dieskalasi: pengingat,
          lalu penangguhan, lalu penghentian. Hari dihitung dari tanggal jatuh
          tempo invoice.
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="toggle-dunning"
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-xs text-foreground">
          Aktifkan eskalasi penagihan tertunggak
        </span>
      </label>

      <div className="grid sm:grid-cols-3 gap-3">
        {[
          ["Pengingat ke-1 (hari)", reminder0, setReminder0, "input-dunning-r0"],
          ["Pengingat ke-2 (hari)", reminder3, setReminder3, "input-dunning-r3"],
          ["Pengingat ke-3 (hari)", reminder7, setReminder7, "input-dunning-r7"],
          ["Tangguhkan (hari)", suspend, setSuspend, "input-dunning-suspend"],
          ["Hentikan (hari)", terminate, setTerminate, "input-dunning-terminate"],
        ].map(([label, val, setter, testId]) => (
          <label key={testId as string} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              {label as string}
            </span>
            <input
              value={val as string}
              onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              inputMode="numeric"
              disabled={!enabled}
              data-testid={testId as string}
              className={`${inputCls} disabled:opacity-50`}
            />
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={save.isPending}
          data-testid="save-dunning-settings"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan kebijakan
        </button>
        {settings && <StatusPill configured={settings.enabled} />}
      </div>
    </form>
  );
}

function fmtRpAdmin(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(n);
}

function FinopsSection() {
  const query = useAdminGetFinops({
    query: { queryKey: getAdminGetFinopsQueryKey() },
  });
  const f = query.data as FinopsSummary | undefined;

  const moneyMetrics: { label: string; value: number }[] = f
    ? [
        { label: "MRR", value: f.mrr },
        { label: "ARR", value: f.arr },
        { label: "ARPU", value: f.arpu },
        { label: "Penerimaan (30 hari)", value: f.billings },
        { label: "Pendapatan diakui (30 hari)", value: f.recognizedRevenue },
      ]
    : [];

  const countMetrics: { label: string; value: string }[] = f
    ? [
        { label: "Total tenant", value: String(f.totalTenants) },
        { label: "Aktif", value: String(f.activeTenants) },
        { label: "Trial", value: String(f.trialTenants) },
        { label: "Jatuh tempo", value: String(f.pastDueTenants) },
        { label: "Ditangguhkan", value: String(f.suspendedTenants) },
        { label: "Kedaluwarsa", value: String(f.expiredTenants) },
        { label: "Churn (30 hari)", value: String(f.churnedTenants) },
        { label: "Churn rate", value: `${f.churnRatePct.toFixed(1)}%` },
      ]
    : [];

  return (
    <div className="border border-border rounded-lg bg-card p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          FinOps (berbasis invoice)
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
          Metrik keuangan dihitung dari invoice resmi: penerimaan kas, pendapatan
          yang diakui per hari, MRR/ARR, ARPU, dan churn dalam 30 hari terakhir.
        </p>
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Memuat metrik…
        </div>
      ) : query.isError || !f ? (
        <p className="text-sm text-destructive py-2" data-testid="finops-error">
          Gagal memuat metrik FinOps.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            {moneyMetrics.map((m) => (
              <div
                key={m.label}
                data-testid={`finops-${m.label}`}
                className="rounded-md border border-border bg-input/40 p-3"
              >
                <div className="text-[11px] text-muted-foreground">
                  {m.label}
                </div>
                <div className="text-base font-semibold tabular-nums mt-0.5">
                  {fmtRpAdmin(m.value)}
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {countMetrics.map((m) => (
              <div
                key={m.label}
                data-testid={`finops-${m.label}`}
                className="rounded-md border border-border bg-input/40 p-3"
              >
                <div className="text-[11px] text-muted-foreground">
                  {m.label}
                </div>
                <div className="text-base font-semibold tabular-nums mt-0.5">
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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

  const methodQuery = useAdminGetPaymentMethod({
    query: { queryKey: getAdminGetPaymentMethodQueryKey() },
  });
  const method = methodQuery.data as PaymentMethodSettings | undefined;
  const [provider, setProvider] = useState<"xendit" | "manual">("xendit");
  useEffect(() => {
    if (method) setProvider(method.activeProvider);
  }, [method?.activeProvider]);

  // Keep the active toggle in sync with the server once loaded.
  useEffect(() => {
    if (status) setIsActive(status.isActive);
  }, [status?.isActive]);

  useEffect(() => {
    document.title = "MaxiChat.App Backend — Gateway Pembayaran";
  }, []);

  function flashOk(m: string) {
    setOkMsg(m);
    if (m) setTimeout(() => setOkMsg(null), 2500);
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: getAdminGetPaymentConfigQueryKey() });
  }

  const updateProvider = useAdminUpdatePaymentMethod({
    mutation: {
      onSuccess: () => {
        flashOk("Metode pembayaran aktif diperbarui.");
        qc.invalidateQueries({ queryKey: getAdminGetPaymentMethodQueryKey() });
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal mengubah metode aktif"),
    },
  });

  function chooseProvider(next: "xendit" | "manual") {
    if (next === provider) return;
    setProvider(next);
    setError(null);
    updateProvider.mutate({ data: { activeProvider: next } });
  }

  const update = useAdminUpdatePaymentConfig({
    mutation: {
      onSuccess: () => {
        setSecretKey("");
        setCallbackToken("");
        flashOk("Konfigurasi gateway tersimpan.");
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
            Pilih metode pembayaran aktif untuk seluruh tenant: gateway otomatis
            (Xendit) atau transfer bank manual dengan verifikasi via Google
            Sheet.
          </p>
        </div>
        <button
          onClick={() => {
            statusQuery.refetch();
            methodQuery.refetch();
          }}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-payment-config"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${
              statusQuery.isFetching || methodQuery.isFetching
                ? "animate-spin"
                : ""
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

      {/* Active provider selector */}
      <section className="border border-border rounded-lg bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
          Metode pembayaran aktif
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => chooseProvider("xendit")}
            data-testid="provider-xendit"
            className={`text-left border rounded-lg p-3 hover-elevate ${
              provider === "xendit"
                ? "border-primary bg-primary/10"
                : "border-border"
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <CreditCard className="w-4 h-4" /> Xendit (otomatis)
              {provider === "xendit" && (
                <CheckCircle2 className="w-4 h-4 text-primary ml-auto" />
              )}
            </span>
            <span className="block text-[11px] text-muted-foreground mt-1">
              VA / QRIS / e-wallet, langsung aktif setelah pembayaran.
            </span>
          </button>
          <button
            type="button"
            onClick={() => chooseProvider("manual")}
            data-testid="provider-manual"
            className={`text-left border rounded-lg p-3 hover-elevate ${
              provider === "manual"
                ? "border-primary bg-primary/10"
                : "border-border"
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Landmark className="w-4 h-4" /> Transfer Manual
              {provider === "manual" && (
                <CheckCircle2 className="w-4 h-4 text-primary ml-auto" />
              )}
            </span>
            <span className="block text-[11px] text-muted-foreground mt-1">
              Pelanggan transfer ke rekening; admin tandai LUNAS di Sheet.
            </span>
          </button>
        </div>
        {updateProvider.isPending && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> Menyimpan...
          </p>
        )}
      </section>

      {provider === "manual" ? (
        <ManualConfigSection
          status={method}
          onError={(m) => setError(m || null)}
          onOk={flashOk}
        />
      ) : (
        <>
          {/* Current Xendit status */}
          <section className="border border-border rounded-lg bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-muted-foreground" />
              Status Xendit
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
              Tempelkan URL ini di dashboard Xendit (Settings → Webhooks →
              Invoices paid) dan pakai callback token yang sama di bawah.
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
        </>
      )}

      <TaxConfigSection onError={(m) => setError(m || null)} onOk={flashOk} />

      <StorageEnforcementSection
        onError={(m) => setError(m || null)}
        onOk={flashOk}
      />

      <OverageRatesSection onError={(m) => setError(m || null)} onOk={flashOk} />

      <DunningSettingsSection
        onError={(m) => setError(m || null)}
        onOk={flashOk}
      />

      <FinopsSection />
    </div>
  );
}
