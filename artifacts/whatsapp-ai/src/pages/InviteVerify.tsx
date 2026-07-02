import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";

type Phase = "verifying" | "success" | "error";

// Agent-invitation landing page. The emailed invite link points here
// (<app_url>/invite/verify?token=…). On mount we POST the token to
// /api/auth/invite/verify, which activates the account (email_verified_at +
// status=active). On success we show an activation message + countdown and
// redirect into /login with the email pre-filled for the OTP step.
export default function InviteVerify() {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [email, setEmail] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [countdown, setCountdown] = useState(5);
  const ranRef = useRef(false); // guard React 18 StrictMode double-invoke

  const token = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return (q.get("token") ?? "").trim();
  }, []);

  // Consume the token once.
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    if (!token) { setPhase("error"); setErrorMsg("Token tidak valid."); return; }

    (async () => {
      try {
        const res = await fetch("/api/auth/invite/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({} as Record<string, unknown>));

        // Treat the idempotent "already used" case as success — a re-click of
        // an already-accepted invite means the account is already active.
        const errText = typeof data?.error === "string" ? data.error : "";
        const alreadyUsed = !res.ok && errText.toLowerCase().includes("sudah pernah digunakan");

        if (res.ok || alreadyUsed) {
          setEmail(typeof data?.email === "string" ? data.email : "");
          setPhase("success");
          return;
        }
        setErrorMsg(errText || "Verifikasi gagal. Coba lagi.");
        setPhase("error");
      } catch {
        setErrorMsg("Tidak dapat terhubung ke server. Coba lagi.");
        setPhase("error");
      }
    })();
  }, [token]);

  // Countdown → redirect once verified.
  useEffect(() => {
    if (phase !== "success") return;
    if (countdown <= 0) {
      const qs = email ? `?verified=1&email=${encodeURIComponent(email)}` : "?verified=1";
      navigate(`/login${qs}`);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown, email, navigate]);

  if (phase === "verifying") {
    return (
      <AuthShell eyebrow="Verifikasi" title="Memverifikasi undangan…" subtitle="Mohon tunggu sebentar.">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-orange-600" />
        </div>
      </AuthShell>
    );
  }

  if (phase === "error") {
    return (
      <AuthShell eyebrow="Verifikasi" title="Verifikasi gagal" subtitle={errorMsg}>
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center">
            <XCircle className="w-8 h-8 text-red-500" />
          </div>
          <Link href="/login" className="text-sm font-semibold text-orange-600 hover:underline">
            Kembali ke Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  // success
  return (
    <AuthShell
      eyebrow="Berhasil"
      title="Email Anda sudah aktif"
      subtitle={email ? `Akun ${email} berhasil diverifikasi.` : "Akun Anda berhasil diverifikasi."}
    >
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
          <CheckCircle2 className="w-8 h-8 text-white" />
        </div>
        <p className="text-sm text-slate-600 text-center">
          Anda akan diarahkan ke halaman masuk dalam <span className="font-bold text-orange-600">{countdown}</span> detik…
        </p>
        <Link href="/login" className="text-xs font-semibold text-orange-600 hover:underline">
          Lanjut sekarang
        </Link>
      </div>
    </AuthShell>
  );
}
