import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { useSignup } from "@workspace/api-client-react";
import {
  Loader2,
  Mail,
  Lock,
  User,
  Building2,
  Phone,
  Eye,
  EyeOff,
  Check,
  X,
} from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import SocialAuthButtons from "@/components/auth/SocialAuthButtons";

interface PasswordChecks {
  length: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
}

function scorePassword(p: string): { score: number; checks: PasswordChecks } {
  const checks: PasswordChecks = {
    length: p.length >= 8,
    upper: /[A-Z]/.test(p),
    digit: /[0-9]/.test(p),
    symbol: /[^A-Za-z0-9]/.test(p),
  };
  const score = Object.values(checks).filter(Boolean).length;
  return { score, checks };
}

const STRENGTH_META = [
  { label: "", color: "" },
  { label: "Sangat lemah", color: "bg-red-500" },
  { label: "Lemah", color: "bg-orange-500" },
  { label: "Cukup", color: "bg-yellow-500" },
  { label: "Kuat", color: "bg-emerald-500" },
];

export default function SignUp() {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { score, checks } = useMemo(() => scorePassword(password), [password]);
  const meta = STRENGTH_META[score];
  const isStrong = score === 4;

  const signupMut = useSignup({
    mutation: {
      onSuccess: (data: any) => {
        const params = new URLSearchParams({ email: data?.email || email });
        if (data?.devVerifyUrl) {
          params.set("dev", data.devVerifyUrl);
        }
        navigate(`/verify-email?${params.toString()}`);
      },
      onError: (err: any) => {
        setError(
          err?.data?.error ||
            err?.data?.message ||
            (err?.status === 409
              ? "Email sudah terdaftar"
              : err?.status === 429
                ? "Terlalu banyak percobaan, coba lagi nanti."
                : "Pendaftaran gagal")
        );
      },
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isStrong) {
      setError(
        "Password harus minimal 8 karakter dan mengandung huruf besar, angka, dan simbol."
      );
      return;
    }
    if (!agreed) {
      setError("Harap setujui Syarat & Ketentuan untuk melanjutkan.");
      return;
    }
    signupMut.mutate({
      data: {
        name: name.trim(),
        companyName: companyName.trim() || null,
        email: email.trim().toLowerCase(),
        mobilePhone: mobilePhone.trim() || null,
        password,
      },
    });
  }

  return (
    <AuthShell
      eyebrow="Get started"
      title="Maxichat.app"
      subtitle="Buat akun Maxichat.app — otomasi balasan WhatsApp dengan AI dalam hitungan menit."
      wide
    >
      <form onSubmit={onSubmit} data-testid="signup-form" className="space-y-4">
        <SocialAuthButtons mode="signup" />

        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-[11px] uppercase tracking-wider text-slate-400">
            atau daftar dengan email
          </span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            icon={<User className="w-4 h-4" />}
            label="Nama lengkap"
            required
            value={name}
            onChange={setName}
            placeholder="Budi Santoso"
            testId="signup-name"
            autoComplete="name"
          />
          <Field
            icon={<Building2 className="w-4 h-4" />}
            label="Nama perusahaan"
            value={companyName}
            onChange={setCompanyName}
            placeholder="PT Maju Jaya (opsional)"
            testId="signup-company"
            autoComplete="organization"
          />
        </div>

        <Field
          icon={<Mail className="w-4 h-4" />}
          label="Email"
          type="email"
          required
          value={email}
          onChange={setEmail}
          placeholder="you@company.com"
          testId="signup-email"
          autoComplete="email"
        />

        <Field
          icon={<Phone className="w-4 h-4" />}
          label="Nomor HP"
          type="tel"
          value={mobilePhone}
          onChange={setMobilePhone}
          placeholder="+62 812 3456 7890 (opsional)"
          testId="signup-phone"
          autoComplete="tel"
        />

        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Password</span>
          <div className="relative mt-1.5">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="signup-password"
              placeholder="Min. 8 karakter"
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
          {password && (
            <div className="mt-2 space-y-2" data-testid="password-strength">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition ${
                      i <= score ? meta.color : "bg-slate-200"
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">Kekuatan password</span>
                <span
                  className={`font-semibold ${
                    score >= 4
                      ? "text-emerald-600"
                      : score >= 3
                        ? "text-yellow-600"
                        : "text-red-600"
                  }`}
                >
                  {meta.label}
                </span>
              </div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-600">
                <Rule ok={checks.length} text="Min. 8 karakter" />
                <Rule ok={checks.upper} text="Huruf besar (A-Z)" />
                <Rule ok={checks.digit} text="Angka (0-9)" />
                <Rule ok={checks.symbol} text="Simbol (!@#…)" />
              </ul>
            </div>
          )}
        </label>

        <label className="flex items-start gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-testid="signup-agree"
            className="mt-0.5 w-4 h-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
          />
          <span>
            Saya setuju dengan{" "}
            <a href="#" className="font-semibold text-orange-600 hover:underline">
              Syarat & Ketentuan
            </a>{" "}
            dan{" "}
            <a href="#" className="font-semibold text-orange-600 hover:underline">
              Kebijakan Privasi
            </a>{" "}
            Maxichat.app.
          </span>
        </label>

        {error && (
          <div
            data-testid="signup-error"
            className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={signupMut.isPending}
          data-testid="signup-submit"
          className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-semibold shadow-lg shadow-orange-500/20 hover:from-orange-600 hover:to-amber-600 active:scale-[.99] transition disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {signupMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Buat akun
        </button>

        <p className="text-center text-xs text-slate-500">
          Sudah punya akun?{" "}
          <Link
            href="/login"
            className="font-semibold text-orange-600 hover:underline"
            data-testid="link-login"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

function Field(props: {
  icon: React.ReactNode;
  label: string;
  type?: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-slate-700">{props.label}</span>
      <div className="relative mt-1.5">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
          {props.icon}
        </span>
        <input
          type={props.type ?? "text"}
          required={props.required}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete={props.autoComplete}
          data-testid={props.testId}
          placeholder={props.placeholder}
          className="w-full h-11 pl-10 pr-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 transition"
        />
      </div>
    </label>
  );
}

function Rule({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={`flex items-center gap-1 ${ok ? "text-emerald-600" : ""}`}>
      {ok ? (
        <Check className="w-3 h-3" />
      ) : (
        <X className="w-3 h-3 text-slate-400" />
      )}
      {text}
    </li>
  );
}
