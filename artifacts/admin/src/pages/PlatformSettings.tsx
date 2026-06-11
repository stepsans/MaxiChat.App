import { useEffect, useState } from "react";
import { Mail, Key, Globe, User, ChevronDown, ChevronUp, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";

interface Settings {
  resendApiKeyConfigured: boolean;
  resendFrom: string | null;
  resendFromName: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPassConfigured: boolean;
  smtpFrom: string | null;
  smtpFromName: string | null;
  ownerEmail: string | null;
  appUrl: string | null;
}

export default function PlatformSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [showSmtp, setShowSmtp] = useState(false);

  const [form, setForm] = useState({
    resendApiKey: "",
    resendFrom: "noreply@maxichat.app",
    resendFromName: "MaxiChat",
    smtpHost: "smtp.gmail.com",
    smtpPort: "587",
    smtpSecure: false,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
    smtpFromName: "MaxiChat",
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
          resendApiKey: "",
          resendFrom: d.resendFrom || "noreply@maxichat.app",
          resendFromName: d.resendFromName || "MaxiChat",
          smtpHost: d.smtpHost || "smtp.gmail.com",
          smtpPort: String(d.smtpPort || 587),
          smtpSecure: d.smtpSecure || false,
          smtpUser: d.smtpUser || "",
          smtpPass: "",
          smtpFrom: d.smtpFrom || "",
          smtpFromName: d.smtpFromName || "MaxiChat",
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
        resendFrom: form.resendFrom,
        resendFromName: form.resendFromName,
        smtpHost: form.smtpHost,
        smtpPort: parseInt(form.smtpPort),
        smtpSecure: form.smtpSecure,
        smtpUser: form.smtpUser,
        smtpFrom: form.smtpFrom,
        smtpFromName: form.smtpFromName,
        ownerEmail: form.ownerEmail,
        appUrl: form.appUrl,
      };
      if (form.resendApiKey.trim()) body.resendApiKey = form.resendApiKey.trim();
      if (form.smtpPass.trim()) body.smtpPass = form.smtpPass.trim();

      const r = await fetch("/api/admin/platform-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Gagal menyimpan."); return; }
      setSettings(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally { setSaving(false); }
  }

  const inp = "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent bg-white transition";
  const lbl = "block text-xs font-semibold text-gray-600 mb-1.5";

  if (loading) return (
    <div className="p-8 flex items-center gap-2 text-gray-400 text-sm">
      <div className="w-4 h-4 border-2 border-orange-300 border-t-orange-600 rounded-full animate-spin" />
      Memuat settings...
    </div>
  );

  const emailProvider = settings?.resendApiKeyConfigured ? "resend" : (settings?.smtpPassConfigured ? "smtp" : "none");

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Platform Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Konfigurasi email dan pengaturan platform MaxiChat</p>
      </div>

      {/* Email Provider Status */}
      <div className={`rounded-2xl px-4 py-3 flex items-center gap-3 text-sm ${
        emailProvider === "resend" ? "bg-green-50 border border-green-200" :
        emailProvider === "smtp" ? "bg-blue-50 border border-blue-200" :
        "bg-amber-50 border border-amber-200"
      }`}>
        {emailProvider === "resend" ? (
          <><CheckCircle className="w-4 h-4 text-green-600 shrink-0" /><span className="text-green-800">Email aktif via <strong>Resend</strong></span></>
        ) : emailProvider === "smtp" ? (
          <><CheckCircle className="w-4 h-4 text-blue-600 shrink-0" /><span className="text-blue-800">Email aktif via <strong>SMTP</strong></span></>
        ) : (
          <><AlertCircle className="w-4 h-4 text-amber-600 shrink-0" /><span className="text-amber-800">Email belum dikonfigurasi — OTP tidak akan terkirim</span></>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-5">

        {/* Resend Section */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-orange-50 rounded-lg flex items-center justify-center">
                <Mail className="w-4 h-4 text-orange-500" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 text-sm">Resend <span className="text-xs font-normal text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full ml-1">Direkomendasikan</span></h2>
                <p className="text-xs text-gray-400">Transactional email API — lebih stabil & deliverability tinggi</p>
              </div>
            </div>
            <a
              href="https://resend.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-orange-600 hover:text-orange-700 flex items-center gap-1 font-medium"
            >
              Daftar <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className={lbl}>
                <Key className="w-3 h-3 inline mr-1" />
                API Key
                {settings?.resendApiKeyConfigured && (
                  <span className="ml-2 text-green-600 font-normal">✓ Sudah dikonfigurasi</span>
                )}
              </label>
              <input
                type="password"
                value={form.resendApiKey}
                onChange={(e) => setForm({ ...form, resendApiKey: e.target.value })}
                placeholder={settings?.resendApiKeyConfigured ? "Kosongkan untuk tidak mengubah" : "re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
                className={inp}
              />
              <p className="text-xs text-gray-400 mt-1.5">
                Dapatkan API key di{" "}
                <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-orange-600 hover:underline">
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
                <p className="text-xs text-gray-400 mt-1">Harus dari domain yang diverifikasi di Resend</p>
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

            {/* Resend setup guide */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <p className="text-xs font-semibold text-gray-600">Cara setup Resend:</p>
              <ol className="text-xs text-gray-500 space-y-1 list-decimal list-inside">
                <li>Daftar di <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="text-orange-600 hover:underline">resend.com</a> (gratis 3.000 email/bulan)</li>
                <li>Tambahkan & verifikasi domain Anda di menu <strong>Domains</strong></li>
                <li>Buat API key di menu <strong>API Keys</strong></li>
                <li>Paste API key di atas dan set alamat pengirim dari domain yang diverifikasi</li>
              </ol>
            </div>
          </div>
        </div>

        {/* SMTP Fallback (collapsible) */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSmtp(!showSmtp)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
                <Mail className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-left">
                <h2 className="font-semibold text-gray-700 text-sm">SMTP (Fallback)</h2>
                <p className="text-xs text-gray-400">Digunakan jika Resend tidak dikonfigurasi</p>
              </div>
            </div>
            {showSmtp ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </button>

          {showSmtp && (
            <div className="px-6 pb-5 space-y-4 border-t border-gray-100 pt-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={lbl}>SMTP Host</label>
                  <input value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} placeholder="smtp.gmail.com" className={inp} />
                </div>
                <div>
                  <label className={lbl}>Port</label>
                  <select
                    value={form.smtpPort}
                    onChange={(e) => { const p = e.target.value; setForm({ ...form, smtpPort: p, smtpSecure: p === "465" }); }}
                    className={inp}
                  >
                    <option value="587">587 (TLS)</option>
                    <option value="465">465 (SSL)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={lbl}>Username / Email SMTP</label>
                <input value={form.smtpUser} onChange={(e) => setForm({ ...form, smtpUser: e.target.value })} placeholder="info@domain.com" className={inp} />
              </div>
              <div>
                <label className={lbl}>
                  Password / App Password
                  {settings?.smtpPassConfigured && <span className="ml-2 text-green-600 font-normal">✓ Sudah dikonfigurasi</span>}
                </label>
                <input
                  type="password"
                  value={form.smtpPass}
                  onChange={(e) => setForm({ ...form, smtpPass: e.target.value })}
                  placeholder={settings?.smtpPassConfigured ? "Kosongkan untuk tidak mengubah" : "App Password"}
                  className={inp}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Alamat Pengirim</label>
                  <input value={form.smtpFrom} onChange={(e) => setForm({ ...form, smtpFrom: e.target.value })} placeholder="info@domain.com" className={inp} />
                </div>
                <div>
                  <label className={lbl}>Nama Pengirim</label>
                  <input value={form.smtpFromName} onChange={(e) => setForm({ ...form, smtpFromName: e.target.value })} placeholder="MaxiChat" className={inp} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Owner & App */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-orange-50 rounded-lg flex items-center justify-center">
              <Globe className="w-4 h-4 text-orange-500" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900 text-sm">Owner & Aplikasi</h2>
              <p className="text-xs text-gray-400">Pengaturan akses owner dan URL platform</p>
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
            <p className="text-xs text-gray-400 mt-1.5">Email ini login dengan OTP tetap (161712). Pastikan diisi sebelum logout.</p>
          </div>
          <div>
            <label className={lbl}><Globe className="w-3 h-3 inline mr-1" />URL Aplikasi (Base URL)</label>
            <input
              value={form.appUrl}
              onChange={(e) => setForm({ ...form, appUrl: e.target.value })}
              placeholder="https://app.maxichat.app"
              className={inp}
            />
            <p className="text-xs text-gray-400 mt-1.5">Dipakai untuk link undangan agent di email.</p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}
        {saved && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-700 text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 shrink-0" />Settings berhasil disimpan.
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full sm:w-auto bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-xl px-8 py-3 text-sm font-semibold shadow-md shadow-orange-200 hover:from-orange-600 hover:to-orange-700 transition disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? (
            <><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />Menyimpan...</>
          ) : "Simpan Settings"}
        </button>
      </form>
    </div>
  );
}
