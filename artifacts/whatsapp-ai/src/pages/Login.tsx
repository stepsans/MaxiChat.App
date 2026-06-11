import { useState, useEffect } from "react";

type Step = "email" | "otp" | "signup_form";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [resendCount, setResendCount] = useState(0);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("verified") === "1" && p.get("email")) {
      setEmail(p.get("email")!);
    }
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const post = async (url: string, body: object) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    return { ok: r.ok, data: await r.json() };
  };

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/otp/request", {
        email,
        purpose: isSignup ? "signup" : "login",
      });
      if (!ok) { setError(data.error || "Gagal mengirim OTP."); return; }
      setExpiresAt(data.expiresAt);
      setCountdown(60);
      setStep("otp");
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/otp/verify", {
        email,
        otp,
        purpose: isSignup ? "signup" : "login",
      });
      if (!ok) { setError(data.error || "OTP tidak valid."); return; }
      if (isSignup && data.otpVerified) { setStep("signup_form"); return; }
      window.location.href = "/";
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/trial", {
        email,
        name,
        companyName: companyName || null,
      });
      if (!ok) { setError(data.error || "Gagal membuat akun."); return; }
      window.location.href = "/";
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  async function handleResend() {
    if (countdown > 0) return;
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await post("/api/auth/otp/resend", {
        email,
        purpose: isSignup ? "signup" : "login",
      });
      if (!ok) { setError(data.error || "Gagal."); return; }
      setResendCount((c) => c + 1);
      setExpiresAt(data.expiresAt);
      setCountdown(60);
    } catch { setError("Terjadi kesalahan."); } finally { setLoading(false); }
  }

  const inputCls =
    "w-full bg-white/80 border border-orange-200 rounded-2xl px-4 py-3.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-all duration-200 backdrop-blur-sm";

  const btnCls =
    "w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-2xl py-3.5 text-sm font-semibold shadow-lg shadow-orange-200 hover:from-orange-600 hover:to-orange-700 hover:shadow-orange-300 active:scale-[0.98] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none";

  const errBox = error ? (
    <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-red-600 text-sm flex items-center gap-2">
      <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
      </svg>
      {error}
    </div>
  ) : null;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden" style={{ background: "linear-gradient(135deg, #fff7ed 0%, #ffedd5 40%, #fed7aa 100%)" }}>
      {/* Decorative blobs */}
      <div className="absolute top-0 right-0 w-96 h-96 rounded-full opacity-30 -translate-y-1/2 translate-x-1/3" style={{ background: "radial-gradient(circle, #fb923c, transparent 70%)" }} />
      <div className="absolute bottom-0 left-0 w-80 h-80 rounded-full opacity-20 translate-y-1/2 -translate-x-1/3" style={{ background: "radial-gradient(circle, #f97316, transparent 70%)" }} />
      <div className="absolute top-1/2 left-1/4 w-64 h-64 rounded-full opacity-10" style={{ background: "radial-gradient(circle, #ea580c, transparent 70%)" }} />

      <div className="w-full max-w-md relative z-10">
        {/* Card */}
        <div className="bg-white/70 backdrop-blur-xl rounded-3xl shadow-2xl shadow-orange-200/50 border border-white/60 p-8">

          {/* Logo & Header */}
          <div className="text-center mb-8">
            <div className="relative inline-flex mb-4">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-orange-300" style={{ background: "linear-gradient(135deg, #f97316, #ea580c)" }}>
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">MaxiChat</h1>
            <p className="text-gray-500 text-sm mt-1.5">
              {step === "signup_form"
                ? "Lengkapi profil Anda"
                : isSignup
                ? "Mulai trial gratis 7 hari"
                : "Selamat datang kembali"}
            </p>
          </div>

          {/* Step indicator */}
          {step !== "email" && (
            <div className="flex items-center justify-center gap-2 mb-6">
              {(["email", "otp", ...(isSignup ? ["signup_form"] : [])] as Step[]).map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full transition-all duration-300 ${s === step ? "w-6 bg-orange-500" : (["email", "otp"].indexOf(s) < ["email", "otp", "signup_form"].indexOf(step)) ? "bg-orange-400" : "bg-gray-200"}`} />
                </div>
              ))}
            </div>
          )}

          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Alamat Email
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <svg className="w-4 h-4 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" />
                    </svg>
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="nama@perusahaan.com"
                    className={inputCls + " pl-11"}
                    autoFocus
                  />
                </div>
              </div>
              {errBox}
              <button type="submit" disabled={loading} className={btnCls}>
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Mengirim kode...
                  </span>
                ) : "Kirim Kode OTP"}
              </button>
              <div className="text-center text-sm text-gray-500 pt-1">
                {isSignup ? (
                  <>
                    Sudah punya akun?{" "}
                    <button
                      type="button"
                      onClick={() => { setIsSignup(false); setError(""); }}
                      className="text-orange-600 font-semibold hover:text-orange-700"
                    >
                      Masuk
                    </button>
                  </>
                ) : (
                  <>
                    Belum punya akun?{" "}
                    <button
                      type="button"
                      onClick={() => { setIsSignup(true); setError(""); }}
                      className="text-orange-600 font-semibold hover:text-orange-700"
                    >
                      Trial Gratis
                    </button>
                  </>
                )}
              </div>
            </form>
          )}

          {step === "otp" && (
            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div className="bg-orange-50 border border-orange-100 rounded-2xl p-4 text-center">
                <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-2">
                  <svg className="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">Kode OTP dikirim ke</p>
                <p className="font-semibold text-gray-900 text-sm mt-0.5">{email}</p>
                {expiresAt && (
                  <p className="text-xs text-gray-400 mt-1">
                    Berlaku hingga{" "}
                    {new Date(expiresAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Kode OTP (6 digit)
                </label>
                <input
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  maxLength={6}
                  placeholder="· · · · · ·"
                  className="w-full bg-white/80 border border-orange-200 rounded-2xl px-4 py-4 text-center text-3xl font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-all duration-200"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
              {errBox}
              <button type="submit" disabled={loading || otp.length !== 6} className={btnCls}>
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Memverifikasi...
                  </span>
                ) : "Verifikasi & Masuk"}
              </button>
              <div className="flex justify-between text-sm pt-1">
                <button
                  type="button"
                  onClick={() => { setStep("email"); setOtp(""); setError(""); }}
                  className="text-gray-500 hover:text-gray-700 flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  Ganti email
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={loading || countdown > 0 || resendCount >= 10}
                  className="text-orange-600 font-medium hover:text-orange-700 disabled:text-gray-400"
                >
                  {countdown > 0 ? `Kirim ulang (${countdown}s)` : "Kirim ulang OTP"}
                </button>
              </div>
            </form>
          )}

          {step === "signup_form" && (
            <form onSubmit={handleSignupSubmit} className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-2xl p-3 flex items-center gap-2">
                <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center shrink-0">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-green-700">
                  Email terverifikasi: <strong>{email}</strong>
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Nama Lengkap
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Budi Santoso"
                  className={inputCls}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Nama Perusahaan{" "}
                  <span className="text-gray-400 font-normal">(opsional)</span>
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="PT Maju Bersama"
                  className={inputCls}
                />
              </div>
              {errBox}
              <button type="submit" disabled={loading || !name.trim()} className={btnCls}>
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Membuat akun...
                  </span>
                ) : "Mulai Trial 7 Hari Gratis"}
              </button>
              <p className="text-xs text-center text-gray-400">
                Tidak perlu kartu kredit · Batalkan kapan saja
              </p>
            </form>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-orange-400/70 mt-6">
          &copy; 2025 MaxiChat · Powered by MaxiPro
        </p>
      </div>
    </div>
  );
}
