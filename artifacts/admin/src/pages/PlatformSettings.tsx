import { useEffect, useState } from "react";
import { Mail, Key, Globe, User, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";

interface Settings {
  emailProvider: "resend" | "gmail";
  resendApiKeyConfigured: boolean;
  resendFrom: string | null;
  resendFromName: string | null;
  gmailUser: string | null;
  gmailClientId: string | null;
  gmailClientSecretConfigured: boolean;
  gmailRefreshTokenConfigured: boolean;
  gmailFromName: string | null;
  ownerEmail: string | null;
  appUrl: string | null;
}

export default function PlatformSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    emailProvider: "resend" as "resend" | "gmail",
    resendApiKey: "",
    resendFrom: "noreply@maxichat.app",
    resendFromName: "MaxiChat",
    gmailUser: "",
    gmailClientId: "",
    gmailClientSecret: "",
    gmailRefreshToken: "",
    gmailFromName: "MaxiChat",
    ownerEmail: "",
    appUrl: "",
  });

  useEffect(() => {
    fetch("/api/admin/platform-settings", { credentials: "include" })
      .then((r) => r.json())
      .then((d: Settings) => {
        setSettings(d);
        setForm((f) => ({
          ...f,
          emailProvider: d.emailProvider || "resend",
          resendApiKey: "",
          resendFrom: d.resendFrom || "noreply@maxichat.app",
          resendFromName: d.resendFromName || "MaxiChat",
          gmailUser: d.gmailUser || "",
          gmailClientId: d.gmailClientId || "",
          gmailClientSecret: "",
          gmailRefreshToken: "",
          gmailFromName: d.gmailFromName || "MaxiChat",
          ownerEmail: d.ownerEmail || "",
          appUrl: d.appUrl || "",
        }));
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        emailProvider: form.emailProvider,
        resendFrom: form.resendFrom,
        resendFromName: form.resendFromName,
        gmailUser: form.gmailUser,
        gmailClientId: form.gmailClientId,
        gmailFromName: form.gmailFromName,
        ownerEmail: form.ownerEmail,
        appUrl: form.appUrl,
      };
      if (form.resendApiKey.trim()) body.resendApiKey = form.resendApiKey.trim();
      if (form.gmailClientSecret.trim()) body.gmailClientSecret = form.gmailClientSecret.trim();
      if (form.gmailRefreshToken.trim()) body.gmailRefreshToken = form.gmailRefreshToken.trim();

      const r = await fetch("/api/admin/platform-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Gagal menyimpan."); return; }
      setSettings(d);
      setForm((f) => ({ ...f, resendApiKey: "", gmailClientSecret: "", gmailRefreshToken: "" }));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally { setSaving(false); }
  }

  const inp = "w-full bg-input border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition";
  const lbl = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";

  if (loading) return (
    <div className="p-8 flex items-center gap-2 text-muted-foreground text-sm">
      <div className="w-4 h-4 border-2 border-muted border-t-primary rounded-full animate-spin" />
      Memuat settings...
    </div>
  );

  const resendReady = !!settings?.resendApiKeyConfigured;
  const gmailReady = !!(settings?.gmailUser && settings?.gmailClientId && settings?.gmailClientSecretConfigured && settings?.gmailRefreshTokenConfigured);
  const activeReady = settings?.emailProvider === "gmail" ? gmailReady : resendReady;

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Platform Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Konfigurasi email dan pengaturan platform MaxiChat</p>
      </div>

      {/* Email Provider Status */}
      <div className={`rounded-lg px-4 py-3 flex items-center gap-3 text-sm border ${
        activeReady ? "bg-emerald-500/10 border-emerald-500/25" : "bg-amber-500/10 border-amber-500/25"
      }`}>
        {activeReady ? (
          <><CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" /><span className="text-emerald-300">Email aktif via <strong>{settings?.emailProvider === "gmail" ? "Gmail OAuth" : "Resend"}</strong></span></>
        ) : (
          <><AlertCircle className="w-4 h-4 text-amber-400 shrink-0" /><span className="text-amber-300">Provider <strong>{settings?.emailProvider === "gmail" ? "Gmail OAuth" : "Resend"}</strong> belum lengkap dikonfigurasi — OTP tidak akan terkirim</span></>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">

        {/* Provider Selector */}
        <div className="bg-card border border-border rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/10 rounded-md flex items-center justify-center">
              <Mail className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-sm">Provider Email</h2>
              <p className="text-xs text-muted-foreground">Pilih layanan untuk mengirim OTP dan email transaksional</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, emailProvider: "resend" })}
              className={`rounded-lg border p-4 text-left transition-colors ${
                form.emailProvider === "resend" ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-foreground">Resend</span>
                {resendReady && <CheckCircle className="w-4 h-4 text-emerald-400" />}
              </div>
              <p className="text-xs text-muted-foreground mt-1">API transaksional — deliverability tinggi, 3.000 email/bulan gratis. Direkomendasikan.</p>
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, emailProvider: "gmail" })}
              className={`rounded-lg border p-4 text-left transition-colors ${
                form.emailProvider === "gmail" ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-foreground">Gmail OAuth</span>
                {gmailReady && <CheckCircle className="w-4 h-4 text-emerald-400" />}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Kirim via akun Gmail dengan OAuth2 — tanpa password. Kuota ±500/hari (gratis) atau 2.000/hari (Workspace).</p>
            </button>
          </div>
        </div>

        {/* Resend Section */}
        {form.emailProvider === "resend" && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-foreground text-sm">Konfigurasi Resend</h2>
              <p className="text-xs text-muted-foreground">Transactional email API</p>
            </div>
            <a
              href="https://resend.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium transition-colors"
            >
              Daftar <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="px-5 py-5 space-y-4">
            <div>
              <label className={lbl}>
                <Key className="w-3 h-3 inline mr-1" />
                API Key
                {settings?.resendApiKeyConfigured && (
                  <span className="ml-2 text-emerald-400 font-normal normal-case tracking-normal">✓ Sudah dikonfigurasi</span>
                )}
              </label>
              <input
                type="password"
                value={form.resendApiKey}
                onChange={(e) => setForm({ ...form, resendApiKey: e.target.value })}
                placeholder={settings?.resendApiKeyConfigured ? "Kosongkan untuk tidak mengubah" : "re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
                className={inp}
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                Dapatkan API key di{" "}
                <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  resend.com/api-keys
                </a>
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Alamat Pengirim</label>
                <input
                  value={form.resendFrom}
                  onChange={(e) => setForm({ ...form, resendFrom: e.target.value })}
                  placeholder="noreply@maxichat.app"
                  className={inp}
                />
                <p className="text-xs text-muted-foreground mt-1">Harus dari domain yang diverifikasi di Resend</p>
              </div>
              <div>
                <label className={lbl}>Nama Pengirim</label>
                <input
                  value={form.resendFromName}
                  onChange={(e) => setForm({ ...form, resendFromName: e.target.value })}
                  placeholder="MaxiChat"
                  className={inp}
                />
              </div>
            </div>

            <div className="bg-muted/50 rounded-md p-4 space-y-2 border border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Cara setup Resend:</p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Daftar di <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">resend.com</a> (gratis 3.000 email/bulan)</li>
                <li>Tambahkan & verifikasi domain Anda di menu <strong className="text-foreground">Domains</strong></li>
                <li>Buat API key di menu <strong className="text-foreground">API Keys</strong></li>
                <li>Paste API key di atas dan set alamat pengirim dari domain yang diverifikasi</li>
              </ol>
            </div>
          </div>
        </div>
        )}

        {/* Gmail OAuth Section */}
        {form.emailProvider === "gmail" && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-foreground text-sm">Konfigurasi Gmail OAuth2</h2>
              <p className="text-xs text-muted-foreground">Kirim email via Gmail tanpa menyimpan password</p>
            </div>
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium transition-colors"
            >
              Google Console <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="px-5 py-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Akun Gmail (Pengirim)</label>
                <input
                  type="email"
                  value={form.gmailUser}
                  onChange={(e) => setForm({ ...form, gmailUser: e.target.value })}
                  placeholder="info@maxichat.app"
                  className={inp}
                />
              </div>
              <div>
                <label className={lbl}>Nama Pengirim</label>
                <input
                  value={form.gmailFromName}
                  onChange={(e) => setForm({ ...form, gmailFromName: e.target.value })}
                  placeholder="MaxiChat"
                  className={inp}
                />
              </div>
            </div>
            <div>
              <label className={lbl}>OAuth Client ID</label>
              <input
                value={form.gmailClientId}
                onChange={(e) => setForm({ ...form, gmailClientId: e.target.value })}
                placeholder="xxxx.apps.googleusercontent.com"
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>
                OAuth Client Secret
                {settings?.gmailClientSecretConfigured && <span className="ml-2 text-emerald-400 font-normal normal-case tracking-normal">✓ Sudah dikonfigurasi</span>}
              </label>
              <input
                type="password"
                value={form.gmailClientSecret}
                onChange={(e) => setForm({ ...form, gmailClientSecret: e.target.value })}
                placeholder={settings?.gmailClientSecretConfigured ? "Kosongkan untuk tidak mengubah" : "GOCSPX-..."}
                className={inp}
              />
            </div>
            <div>
              <label className={lbl}>
                Refresh Token
                {settings?.gmailRefreshTokenConfigured && <span className="ml-2 text-emerald-400 font-normal normal-case tracking-normal">✓ Sudah dikonfigurasi</span>}
              </label>
              <input
                type="password"
                value={form.gmailRefreshToken}
                onChange={(e) => setForm({ ...form, gmailRefreshToken: e.target.value })}
                placeholder={settings?.gmailRefreshTokenConfigured ? "Kosongkan untuk tidak mengubah" : "1//..."}
                className={inp}
              />
            </div>

            <div className="bg-muted/50 rounded-md p-4 space-y-2 border border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Cara setup Gmail OAuth2:</p>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Buka <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google Cloud Console → Credentials</a>, buat <strong className="text-foreground">OAuth Client ID</strong> (tipe Web application)</li>
                <li>Tambahkan <code className="text-foreground">https://developers.google.com/oauthplayground</code> sebagai Authorized redirect URI</li>
                <li>Buka <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">OAuth Playground</a>, klik ⚙️ → centang "Use your own OAuth credentials", isi Client ID & Secret</li>
                <li>Authorize scope <code className="text-foreground">https://mail.google.com/</code> dengan akun Gmail pengirim</li>
                <li>Klik "Exchange authorization code for tokens" → salin <strong className="text-foreground">Refresh Token</strong> ke atas</li>
              </ol>
              <p className="text-xs text-amber-400/90 mt-2">Catatan: kuota Gmail ±500 email/hari (gratis) atau 2.000/hari (Workspace). Untuk volume besar, gunakan Resend.</p>
            </div>
          </div>
        </div>
        )}

        {/* Owner & App */}
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/10 rounded-md flex items-center justify-center">
              <Globe className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-sm">Owner & Aplikasi</h2>
              <p className="text-xs text-muted-foreground">Pengaturan akses owner dan URL platform</p>
            </div>
          </div>
          <div>
            <label className={lbl}><User className="w-3 h-3 inline mr-1" />Email Owner Platform</label>
            <input
              type="email"
              value={form.ownerEmail}
              onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
              placeholder="owner@maxichat.app"
              className={inp}
            />
            <p className="text-xs text-muted-foreground mt-1.5">Email owner platform. Login memakai OTP yang dikirim via email seperti user biasa.</p>
          </div>
          <div>
            <label className={lbl}><Globe className="w-3 h-3 inline mr-1" />URL Aplikasi (Base URL)</label>
            <input
              value={form.appUrl}
              onChange={(e) => setForm({ ...form, appUrl: e.target.value })}
              placeholder="https://app.maxichat.app"
              className={inp}
            />
            <p className="text-xs text-muted-foreground mt-1.5">Dipakai untuk link undangan agent di email.</p>
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md px-4 py-3 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}
        {saved && (
          <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-md px-4 py-3 text-emerald-400 text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />Settings berhasil disimpan.
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="bg-primary text-primary-foreground rounded-md px-6 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? (
            <><div className="w-4 h-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />Menyimpan...</>
          ) : "Simpan Settings"}
        </button>
      </form>
    </div>
  );
}
