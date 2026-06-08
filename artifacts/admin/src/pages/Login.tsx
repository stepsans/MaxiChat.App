import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";

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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-primary-foreground"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          </div>
          <h1 className="text-lg font-semibold">MaxiChat.App Backend</h1>
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
