import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLogin,
  useSignup,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { SiWhatsapp } from "react-icons/si";
import { Loader2 } from "lucide-react";

type Mode = "login" | "signup";

export default function Login() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function resetMessages() {
    setError(null);
    setInfo(null);
  }
  function switchMode(next: Mode) {
    resetMessages();
    setPassword("");
    setMode(next);
  }

  const loginMut = useLogin({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        navigate("/");
      },
      onError: (err: any) => {
        const msg =
          err?.data?.error ||
          err?.data?.message ||
          (err?.status === 401
            ? "Email atau password salah"
            : err?.status === 403
              ? "Akun belum disetujui admin"
              : "Login gagal");
        setError(msg);
      },
    },
  });

  const signupMut = useSignup({
    mutation: {
      onSuccess: (data: any) => {
        setInfo(
          data?.message ||
            "Akun berhasil dibuat. Menunggu persetujuan admin sebelum dapat login."
        );
        setPassword("");
        setMode("login");
      },
      onError: (err: any) => {
        const msg =
          err?.data?.error ||
          err?.data?.message ||
          (err?.status === 409
            ? "Email sudah terdaftar"
            : "Pendaftaran gagal");
        setError(msg);
      },
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    resetMessages();
    const payload = {
      email: email.trim().toLowerCase(),
      password,
    };
    if (mode === "login") {
      loginMut.mutate({ data: payload });
    } else {
      signupMut.mutate({ data: payload });
    }
  }

  const isPending = loginMut.isPending || signupMut.isPending;
  const isSignup = mode === "signup";

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 space-y-5 shadow-sm"
        data-testid={isSignup ? "signup-form" : "login-form"}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="w-11 h-11 rounded-lg bg-primary flex items-center justify-center">
            <SiWhatsapp className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">VJ-Chat</h1>
          <p className="text-xs text-muted-foreground">
            {isSignup
              ? "Buat akun baru — perlu persetujuan admin"
              : "Masuk untuk membuka dashboard"}
          </p>
        </div>

        <div
          role="tablist"
          className="grid grid-cols-2 gap-1 p-1 bg-muted/50 rounded-md"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isSignup}
            data-testid="tab-login"
            onClick={() => switchMode("login")}
            className={`h-7 text-xs font-medium rounded ${
              !isSignup
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Masuk
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isSignup}
            data-testid="tab-signup"
            onClick={() => switchMode("signup")}
            className={`h-7 text-xs font-medium rounded ${
              isSignup
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Daftar
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-foreground/80">
              Email
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid={isSignup ? "signup-email" : "login-email"}
              className="mt-1 w-full h-9 px-3 rounded-md border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-foreground/80">
              Password
              {isSignup && (
                <span className="text-muted-foreground font-normal">
                  {" "}
                  (min. 8 karakter)
                </span>
              )}
            </span>
            <input
              type="password"
              required
              minLength={isSignup ? 8 : 1}
              autoComplete={isSignup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid={isSignup ? "signup-password" : "login-password"}
              className="mt-1 w-full h-9 px-3 rounded-md border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
        </div>

        {error && (
          <div
            data-testid="login-error"
            className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2"
          >
            {error}
          </div>
        )}
        {info && (
          <div
            data-testid="login-info"
            className="text-xs text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2"
          >
            {info}
          </div>
        )}

        <button
          type="submit"
          disabled={isPending}
          data-testid={isSignup ? "signup-submit" : "login-submit"}
          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSignup ? "Daftar" : "Masuk"}
        </button>
      </form>
    </div>
  );
}
