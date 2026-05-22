import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLogin,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { SiWhatsapp } from "react-icons/si";
import { Loader2 } from "lucide-react";

export default function Login() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginMut = useLogin({
    mutation: {
      onSuccess: async () => {
        // Invalidate /auth/me so the App-level guard re-fetches and lets us in.
        await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        navigate("/");
      },
      onError: (err: any) => {
        const msg =
          err?.data?.error ||
          err?.data?.message ||
          (err?.status === 401 ? "Email atau password salah" : "Login gagal");
        setError(msg);
      },
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    loginMut.mutate({ data: { email: email.trim().toLowerCase(), password } });
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 space-y-5 shadow-sm"
        data-testid="login-form"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="w-11 h-11 rounded-lg bg-primary flex items-center justify-center">
            <SiWhatsapp className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">VJ-Chat</h1>
          <p className="text-xs text-muted-foreground">
            Masuk untuk membuka dashboard
          </p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-foreground/80">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="login-email"
              className="mt-1 w-full h-9 px-3 rounded-md border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-foreground/80">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
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

        <button
          type="submit"
          disabled={loginMut.isPending}
          data-testid="login-submit"
          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {loginMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Masuk
        </button>
      </form>
    </div>
  );
}
