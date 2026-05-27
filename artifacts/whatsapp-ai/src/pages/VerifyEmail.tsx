import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useVerifyEmail,
  useResendVerification,
} from "@workspace/api-client-react";
import {
  Loader2,
  MailCheck,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";

type Status = "idle" | "verifying" | "verified" | "error";

const RESEND_COOLDOWN = 60;

export default function VerifyEmail() {
  const [location] = useLocation();
  const search = useMemo(() => {
    const idx = location.indexOf("?");
    const raw = idx >= 0 ? location.slice(idx) : window.location.search;
    return new URLSearchParams(raw);
  }, [location]);
  const tokenFromUrl = search.get("token");
  const emailFromUrl = search.get("email") ?? "";
  const devVerifyUrlFromUrl = search.get("dev");

  const [status, setStatus] = useState<Status>(tokenFromUrl ? "verifying" : "idle");
  const [message, setMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [devVerifyUrl, setDevVerifyUrl] = useState<string | null>(
    devVerifyUrlFromUrl
  );

  const verifyMut = useVerifyEmail({
    mutation: {
      onSuccess: () => {
        setStatus("verified");
        setMessage("Email berhasil diverifikasi. Anda sekarang bisa masuk.");
      },
      onError: (err: any) => {
        setStatus("error");
        setMessage(err?.data?.error || "Token tidak valid atau sudah kedaluwarsa.");
      },
    },
  });

  const resendMut = useResendVerification({
    mutation: {
      onSuccess: (data: any) => {
        setMessage(
          "Link verifikasi baru sudah dikirim. Cek inbox (dan folder spam)."
        );
        if (data?.devVerifyUrl) setDevVerifyUrl(data.devVerifyUrl);
        setCooldown(RESEND_COOLDOWN);
      },
      onError: () => {
        setMessage("Gagal mengirim ulang. Coba lagi sebentar.");
      },
    },
  });

  // Auto-fire verify once when a token is in the URL.
  useEffect(() => {
    if (tokenFromUrl) {
      verifyMut.mutate({ data: { token: tokenFromUrl } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromUrl]);

  // Countdown timer for the resend button. Decrements every second until 0.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  function handleResend() {
    if (!emailFromUrl || cooldown > 0 || resendMut.isPending) return;
    setMessage(null);
    resendMut.mutate({ data: { email: emailFromUrl } });
  }

  // ── Render states ────────────────────────────────────────────────────
  if (status === "verifying") {
    return (
      <AuthShell title="Memverifikasi email…" subtitle="Mohon tunggu sebentar.">
        <div className="flex flex-col items-center gap-3 py-8 text-slate-600">
          <Loader2 className="w-8 h-8 animate-spin text-orange-600" />
          <p className="text-sm">Menghubungi server…</p>
        </div>
      </AuthShell>
    );
  }

  if (status === "verified") {
    return (
      <AuthShell title="Email terverifikasi!" subtitle={message ?? undefined}>
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7 text-emerald-600" />
          </div>
          <Link
            href="/login"
            data-testid="link-go-login"
            className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-semibold shadow-lg shadow-orange-500/20 hover:from-orange-600 hover:to-amber-600 active:scale-[.99] transition flex items-center justify-center"
          >
            Lanjut ke Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (status === "error") {
    return (
      <AuthShell
        title="Verifikasi gagal"
        subtitle={message ?? "Token mungkin sudah kedaluwarsa."}
      >
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
            <AlertCircle className="w-7 h-7 text-red-600" />
          </div>
          {emailFromUrl && (
            <button
              type="button"
              onClick={handleResend}
              disabled={resendMut.isPending || cooldown > 0}
              data-testid="btn-resend"
              className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-semibold shadow-lg shadow-orange-500/20 hover:from-orange-600 hover:to-amber-600 active:scale-[.99] transition disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {resendMut.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              {cooldown > 0 ? `Kirim ulang (${cooldown}s)` : "Kirim ulang link"}
            </button>
          )}
          <Link
            href="/login"
            className="text-xs font-semibold text-orange-600 hover:underline"
          >
            Kembali ke Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  // status === "idle": came from signup — show "check your email" view.
  return (
    <AuthShell
      eyebrow="Hampir selesai"
      title="Cek inbox Anda"
      subtitle={
        emailFromUrl
          ? `Kami sudah mengirim link verifikasi ke ${emailFromUrl}. Klik link tersebut untuk mengaktifkan akun.`
          : "Kami sudah mengirim link verifikasi ke email Anda."
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
            <MailCheck className="w-8 h-8 text-white" />
          </div>
        </div>

        {devVerifyUrl && (
          <div
            data-testid="dev-verify-banner"
            className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3"
          >
            <div className="font-semibold mb-1">Mode pengembangan</div>
            <p className="mb-2">
              Email belum dikonfigurasi. Buka link berikut untuk verifikasi
              manual:
            </p>
            <a
              href={devVerifyUrl}
              className="font-semibold underline break-all"
              data-testid="dev-verify-link"
            >
              {devVerifyUrl}
            </a>
          </div>
        )}

        {message && (
          <div
            data-testid="verify-message"
            className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
          >
            {message}
          </div>
        )}

        {emailFromUrl && (
          <button
            type="button"
            onClick={handleResend}
            disabled={resendMut.isPending || cooldown > 0}
            data-testid="btn-resend"
            className="w-full h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[.99] transition disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {resendMut.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {cooldown > 0
              ? `Kirim ulang dalam ${cooldown} detik`
              : "Kirim ulang link verifikasi"}
          </button>
        )}

        <p className="text-center text-xs text-slate-500">
          Sudah verifikasi?{" "}
          <Link href="/login" className="font-semibold text-orange-600 hover:underline">
            Sign in sekarang
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
