import { useState } from "react";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const post = async (url: string, body: object) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    return { ok: r.ok, data: await r.json() };
  };

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/otp/request", {
        email,
        purpose: "login",
      });
      if (!ok) { setError(data.error || "Gagal."); return; }
      setStep("otp");
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  async function handleOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/otp/verify", {
        email,
        otp,
        purpose: "login",
      });
      if (!ok) { setError(data.error || "OTP salah."); return; }
      if (data.user?.role !== "admin" && data.role !== "admin") {
        setError("Akses ditolak. Halaman ini khusus platform operator.");
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
        return;
      }
      window.location.reload();
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  const inputCls =
    "w-full bg-white border border-orange-200 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-all duration-200";

  const btnCls =
    "w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-xl py-3 text-sm font-semibold shadow-md shadow-orange-200 hover:from-orange-600 hover:to-orange-700 active:scale-[0.98] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "linear-gradient(160deg, #1c1917 0%, #292524 50%, #1c1917 100%)" }}>
      {/* Subtle orange glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] opacity-20 rounded-full blur-3xl" style={{ background: "radial-gradient(ellipse, #f97316, transparent 70%)" }} />

      <div className="w-full max-w-sm relative z-10">
        {/* Card */}
        <div className="bg-white/[0.04] backdrop-blur-xl rounded-2xl border border-white/10 p-8 shadow-2xl">

          {/* Logo & Header */}
          <div className="text-center mb-8">
            <div className="w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center shadow-lg shadow-orange-900/50" style={{ background: "linear-gradient(135deg, #f97316, #c2410c)" }}>
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white">MaxiChat Admin</h1>
            <div className="flex items-center justify-center gap-1.5 mt-1.5">
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full" />
              <p className="text-xs text-orange-400/80 font-medium tracking-wide uppercase">Platform Operator Panel</p>
            </div>
          </div>

          {step === "email" && (
            <form onSubmit={handleEmail} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Email Operator
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="operator@platform.com"
                  className={inputCls}
                  autoFocus
                />
              </div>
              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} className={btnCls}>
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Mengirim...
                  </span>
                ) : "Lanjut"}
              </button>
            </form>
          )}

          {step === "otp" && (
            <form onSubmit={handleOtp} className="space-y-4">
              <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-400">Kode OTP dikirim ke</p>
                <p className="text-sm font-semibold text-orange-300 mt-0.5">{email}</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Kode OTP
                </label>
                <input
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  placeholder="· · · · · ·"
                  className="w-full bg-white border border-orange-200 rounded-xl px-4 py-4 text-center text-3xl font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-all duration-200"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} className={btnCls}>
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Memverifikasi...
                  </span>
                ) : "Masuk ke Dashboard"}
              </button>
              <button
                type="button"
                onClick={() => { setStep("email"); setOtp(""); setError(""); }}
                className="w-full text-sm text-gray-500 hover:text-gray-300 flex items-center justify-center gap-1 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Ganti email
              </button>
            </form>
          )}
        </div>

        {/* Security note */}
        <p className="text-center text-xs text-gray-600 mt-5 flex items-center justify-center gap-1.5">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          Akses terbatas untuk platform operator
        </p>
      </div>
    </div>
  );
}
