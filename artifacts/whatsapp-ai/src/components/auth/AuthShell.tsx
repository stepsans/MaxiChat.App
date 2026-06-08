import type { ReactNode } from "react";
import { SiWhatsapp } from "react-icons/si";
import { MessageSquareText, Users, BarChart3, Sparkles } from "lucide-react";

interface AuthShellProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  // Sign-up form is taller than sign-in; let it claim a wider card so the
  // two-column "Nama / Perusahaan" row breathes on desktop.
  wide?: boolean;
}

// Split-screen auth layout: branded gradient panel on the left (with a
// stylized dashboard preview), form panel on the right. Collapses to a
// single column on mobile.
export default function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  wide,
}: AuthShellProps) {
  return (
    <div
      className="min-h-screen w-full grid md:grid-cols-2 bg-slate-50"
      style={{ fontFamily: "'Plus Jakarta Sans', Inter, system-ui, sans-serif" }}
    >
      <BrandPanel />
      <div className="flex items-center justify-center px-4 py-10 md:py-12">
        <div className={`w-full ${wide ? "max-w-xl" : "max-w-md"}`}>
          <div className="md:hidden flex items-center gap-2 mb-6">
            <Logo />
            <span className="font-bold text-slate-900 text-lg">Maxichat.app</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl shadow-slate-200/50 p-6 sm:p-8">
            <div className="mb-6">
              {eyebrow && (
                <div className="text-[11px] font-semibold uppercase tracking-wider text-orange-600 mb-1.5">
                  {eyebrow}
                </div>
              )}
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-2 text-sm text-slate-500 leading-relaxed">
                  {subtitle}
                </p>
              )}
            </div>
            {children}
          </div>
          <p className="text-center text-[11px] text-slate-400 mt-6">
            © {new Date().getFullYear()} Maxichat.app.
          </p>
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
      <SiWhatsapp className="w-4.5 h-4.5 text-white" />
    </div>
  );
}

function BrandPanel() {
  return (
    <div className="relative hidden md:flex flex-col justify-between overflow-hidden bg-gradient-to-br from-orange-500 via-orange-600 to-amber-600 text-white p-10">
      {/* decorative blobs */}
      <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-amber-300/40 blur-3xl" />
      <div className="absolute -bottom-24 -left-24 w-80 h-80 rounded-full bg-orange-300/40 blur-3xl" />

      <div className="relative z-10 flex items-center gap-2.5">
        <Logo />
        <span className="font-bold text-lg tracking-tight">Maxichat.app</span>
      </div>

      <div className="relative z-10 my-8">
        <h2 className="text-4xl font-bold leading-tight tracking-tight">
          Maxichat.app
        </h2>
        <p className="mt-4 text-sm text-orange-50 max-w-sm leading-relaxed">
          Otomasi balasan WhatsApp, kelola tim agent, dan analisa percakapan —
          semua dalam satu dashboard pintar bertenaga AI.
        </p>

        {/* Stylized dashboard preview */}
        <div className="mt-8 relative">
          <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-4 shadow-2xl shadow-orange-900/40">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <div className="w-2 h-2 rounded-full bg-yellow-400" />
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <div className="ml-2 text-[10px] text-orange-50/90">
                dashboard.maxichat.com
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <Stat icon={<MessageSquareText className="w-3 h-3" />} label="Chats" value="1,284" />
              <Stat icon={<Users className="w-3 h-3" />} label="Agents" value="12" />
              <Stat icon={<BarChart3 className="w-3 h-3" />} label="Resolved" value="92%" />
            </div>
            <div className="space-y-1.5">
              <ChatRow name="Andi" preview="Halo, saya mau pesan…" badge="AI" />
              <ChatRow name="Sari" preview="Cek status order #481" badge="Agent" />
              <ChatRow name="Bima" preview="Terima kasih ✨" muted />
            </div>
          </div>
          <div className="absolute -bottom-3 -right-3 bg-white text-slate-900 rounded-xl px-3 py-2 shadow-xl flex items-center gap-1.5 text-xs font-semibold">
            <Sparkles className="w-3.5 h-3.5 text-orange-600" />
            AI active
          </div>
        </div>
      </div>

      <div className="relative z-10 text-[11px] text-orange-50/80">
        Dipercaya oleh tim customer-service di seluruh Indonesia.
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-white/10 rounded-lg p-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-orange-50/90">
        {icon}
        {label}
      </div>
      <div className="text-sm font-bold mt-0.5">{value}</div>
    </div>
  );
}

function ChatRow({
  name,
  preview,
  badge,
  muted,
}: {
  name: string;
  preview: string;
  badge?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 bg-white/10 rounded-lg px-2 py-1.5 ${
        muted ? "opacity-60" : ""
      }`}
    >
      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-amber-300 to-orange-500 flex items-center justify-center text-[10px] font-bold">
        {name[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold leading-tight">{name}</div>
        <div className="text-[10px] text-orange-50/90 truncate">{preview}</div>
      </div>
      {badge && (
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
            badge === "AI"
              ? "bg-white/25 text-white"
              : "bg-emerald-400/30 text-emerald-100"
          }`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
