import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLogin,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Loader2, Mail, Lock, Eye, EyeOff } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import SocialAuthButtons from "@/components/auth/SocialAuthButtons";

export default function Login() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  const loginMut = useLogin({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        navigate("/");
      },
      onError: (err: any) => {
        const data = err?.data ?? {};
        if (data.reason === "email_not_verified") {
          setUnverifiedEmail(data.email ?? email);
          setError(data.error || "Email belum diverifikasi.");
          return;
        }
        setUnverifiedEmail(null);
        setError(
          data.error ||
            data.message ||
            (err?.status === 401
              ? "Email atau password salah"
              : err?.status === 403
                ? "Akun belum aktif"
                : "Login gagal")
        );
      },
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    loginMut.mutate({
      data: { email: email.trim().toLowerCase(), password },
    });
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to MaxiChat"
      subtitle="Maximizing Your Chat — kelola semua percakapan WhatsApp dari satu dashboard."
    >
      <form onSubmit={onSubmit} data-testid="login-form" className="space-y-4">
        <SocialAuthButtons mode="login" />

        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-[11px] uppercase tracking-wider text-slate-400">
            atau gunakan email
          </span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Email</span>
          <div className="relative mt-1.5">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="login-email"
              placeholder="you@company.com"
              className="w-full h-11 pl-10 pr-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 transition"
            />
          </div>
        </label>

        <label className="block">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700">Password</span>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="text-[11px] font-medium text-orange-600 hover:underline"
            >
              Lupa password?
            </a>
          </div>
          <div className="relative mt-1.5">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
              placeholder="••••••••"
              className="w-full h-11 pl-10 pr-10 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 transition"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </label>

        {error && (
          <div
            data-testid="login-error"
            className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"
          >
            {error}
            {unverifiedEmail && (
              <>
                {" "}
                <Link
                  href={`/verify-email?email=${encodeURIComponent(unverifiedEmail)}`}
                  className="font-semibold underline"
                >
                  Kirim ulang link verifikasi
                </Link>
              </>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loginMut.isPending}
          data-testid="login-submit"
          className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-semibold shadow-lg shadow-orange-500/20 hover:from-orange-600 hover:to-amber-600 active:scale-[.99] transition disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {loginMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Sign in
        </button>

        <p className="text-center text-xs text-slate-500">
          Belum punya akun?{" "}
          <Link
            href="/signup"
            className="font-semibold text-orange-600 hover:underline"
            data-testid="link-signup"
          >
            Buat akun gratis
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
