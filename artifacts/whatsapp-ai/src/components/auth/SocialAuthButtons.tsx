import { useToast } from "@/hooks/use-toast";

// Google/Microsoft buttons are rendered for visual completeness — actual
// OAuth isn't wired up yet (no client IDs provisioned). Tapping either
// shows a "Coming soon" toast so the user gets explicit feedback rather
// than a silent click. When OAuth is added, swap the onClick to kick off
// the real /auth/oauth/<provider>/start flow.

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.12-1.44.34-2.11V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.65l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden>
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

export default function SocialAuthButtons({
  mode,
}: {
  mode: "login" | "signup";
}) {
  const { toast } = useToast();
  const verb = mode === "login" ? "Sign in" : "Sign up";
  function comingSoon(provider: string) {
    toast({
      title: `${provider} ${verb.toLowerCase()} coming soon`,
      description:
        "Integrasi OAuth sedang disiapkan. Sementara ini gunakan email.",
    });
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => comingSoon("Google")}
        data-testid="social-google"
        className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[.99] transition flex items-center justify-center gap-2"
      >
        <GoogleIcon />
        Google
      </button>
      <button
        type="button"
        onClick={() => comingSoon("Microsoft")}
        data-testid="social-microsoft"
        className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[.99] transition flex items-center justify-center gap-2"
      >
        <MicrosoftIcon />
        Microsoft
      </button>
    </div>
  );
}
