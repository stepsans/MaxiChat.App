import { useEffect, useState } from "react";

interface Settings {
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
  const [form, setForm] = useState({
    smtpHost: "smtp.gmail.com",
    smtpPort: "587",
    smtpSecure: false,
    smtpUser: "info@maxichat.app",
    smtpPass: "",
    smtpFrom: "info@maxichat.app",
    smtpFromName: "MaxiChat",
    ownerEmail: "",
    appUrl: "",
  });

  useEffect(() => {
    fetch("/api/admin/platform-settings", { credentials: "include" })
      .then((r) => r.json())
      .then((d: Settings) => {
        setSettings(d);
        setForm({
          smtpHost: d.smtpHost || "smtp.gmail.com",
          smtpPort: String(d.smtpPort || 587),
          smtpSecure: d.smtpSecure || false,
          smtpUser: d.smtpUser || "info@maxichat.app",
          smtpPass: "",
          smtpFrom: d.smtpFrom || "info@maxichat.app",
          smtpFromName: d.smtpFromName || "MaxiChat",
          ownerEmail: d.ownerEmail || "",
          appUrl: d.appUrl || "",
        });
      })
      .finally(() => setLoading(false));
  }, []);

  function handlePortChange(port: string) {
    const p = parseInt(port);
    setForm({ ...form, smtpPort: port, smtpSecure: p === 465 });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        smtpHost: form.smtpHost,
        smtpPort: parseInt(form.smtpPort),
        smtpSecure: form.smtpSecure,
        smtpUser: form.smtpUser,
        smtpFrom: form.smtpFrom,
        smtpFromName: form.smtpFromName,
        ownerEmail: form.ownerEmail,
        appUrl: form.appUrl,
      };
      if (form.smtpPass.trim()) body.smtpPass = form.smtpPass;
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

  const inp =
    "w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const label = "block text-xs font-medium text-gray-700 mb-1";

  if (loading) return <div className="p-8 text-gray-500 text-sm">Memuat...</div>;

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Platform Settings</h1>
      <p className="text-sm text-gray-500 mb-8">
        Konfigurasi SMTP dan pengaturan platform MaxiChat
      </p>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900">Konfigurasi Email (SMTP)</h2>
            <p className="text-xs text-gray-400 mt-1">
              Untuk Google Workspace: gunakan App Password, bukan password akun.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={label}>SMTP Host</label>
              <input
                value={form.smtpHost}
                onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                placeholder="smtp.gmail.com"
                className={inp}
              />
            </div>
            <div>
              <label className={label}>Port</label>
              <select
                value={form.smtpPort}
                onChange={(e) => handlePortChange(e.target.value)}
                className={inp}
              >
                <option value="587">587 (TLS)</option>
                <option value="465">465 (SSL)</option>
              </select>
            </div>
          </div>

          <div className="text-xs text-gray-500 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${form.smtpSecure ? "bg-green-500" : "bg-blue-500"}`}
            />
            {form.smtpSecure ? "SSL — secure: true" : "STARTTLS — secure: false"}
          </div>

          <div>
            <label className={label}>Username / Email SMTP</label>
            <input
              value={form.smtpUser}
              onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
              placeholder="info@maxichat.app"
              className={inp}
            />
          </div>

          <div>
            <label className={label}>
              App Password / SMTP Password
              {settings?.smtpPassConfigured && (
                <span className="ml-2 text-green-600 font-normal">
                  ✓ Sudah dikonfigurasi
                </span>
              )}
            </label>
            <input
              type="password"
              value={form.smtpPass}
              onChange={(e) => setForm({ ...form, smtpPass: e.target.value })}
              placeholder={
                settings?.smtpPassConfigured
                  ? "Kosongkan untuk tidak mengubah"
                  : "App Password (contoh: zjug flkm fcpr vtkk)"
              }
              className={inp}
            />
            <p className="text-xs text-gray-400 mt-1">
              Google: Settings → Security → 2-Step Verification → App passwords
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Alamat Pengirim</label>
              <input
                value={form.smtpFrom}
                onChange={(e) => setForm({ ...form, smtpFrom: e.target.value })}
                placeholder="info@maxichat.app"
                className={inp}
              />
            </div>
            <div>
              <label className={label}>Nama Pengirim</label>
              <input
                value={form.smtpFromName}
                onChange={(e) => setForm({ ...form, smtpFromName: e.target.value })}
                placeholder="MaxiChat"
                className={inp}
              />
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Owner & Aplikasi</h2>
          <div>
            <label className={label}>Email Owner Platform</label>
            <input
              type="email"
              value={form.ownerEmail}
              onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
              placeholder="owner@maxichat.app"
              className={inp}
            />
            <p className="text-xs text-gray-400 mt-1">
              Email ini login dengan OTP tetap (161712). Pastikan diisi sebelum logout.
            </p>
          </div>
          <div>
            <label className={label}>URL Aplikasi (Base URL)</label>
            <input
              value={form.appUrl}
              onChange={(e) => setForm({ ...form, appUrl: e.target.value })}
              placeholder="https://app.maxichat.app"
              className={inp}
            />
            <p className="text-xs text-gray-400 mt-1">
              Dipakai untuk link invitation agent di email.
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm">
            {error}
          </div>
        )}
        {saved && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-700 text-sm">
            ✓ Settings berhasil disimpan.
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 text-white rounded-xl px-6 py-3 text-sm font-semibold hover:bg-blue-700 transition disabled:opacity-50"
        >
          {saving ? "Menyimpan..." : "Simpan Settings"}
        </button>
      </form>
    </div>
  );
}
