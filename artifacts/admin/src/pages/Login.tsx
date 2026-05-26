import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { Loader2, ShieldCheck } from "lucide-react";

export default function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const login = useLogin({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
      onError: (err: any) => {
        const msg =
          err?.data?.error ||
          err?.data?.message ||
          (err?.status === 401
            ? "Email atau password salah"
            : err?.status === 403
              ? "Akun tidak aktif"
              : "Login gagal");
        setError(msg);
      },
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    login.mutate({ data: { email: email.trim().toLowerCase(), password } });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-card border border-border rounded-lg p-6 space-y-5 shadow-sm"
        data-testid="admin-login-form"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="w-11 h-11 rounded-lg bg-primary flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary-foreground" />
          </div>
          <h1 className="text-lg font-semibold">MaxiCS Admin</h1>
          <p className="text-xs text-muted-foreground">
            Khusus untuk super admin
          </p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-foreground/80">Email</span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="admin-email"
              className="mt-1 w-full h-9 px-3 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
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
              data-testid="admin-password"
              className="mt-1 w-full h-9 px-3 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          data-testid="admin-submit"
          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {login.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Masuk
        </button>
      </form>
    </div>
  );
}
