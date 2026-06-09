import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import {
  Loader2,
  ShieldAlert,
  LogOut,
  Users as UsersIcon,
  Cpu,
  Tag,
  Wallet,
  TrendingUp,
  Package,
  CreditCard,
  Rocket,
} from "lucide-react";
import Login from "./pages/Login";
import Users from "./pages/Users";
import TokenUsage from "./pages/TokenUsage";
import Pricing from "./pages/Pricing";
import Plans from "./pages/Plans";
import Billing from "./pages/Billing";
import Analytics from "./pages/Analytics";
import PaymentGateway from "./pages/PaymentGateway";
import TrialMonitor from "./pages/TrialMonitor";
import { useLogoutMutation } from "./lib/useLogoutMutation";

const queryClient = new QueryClient();

type AdminTab =
  | "users"
  | "usage"
  | "pricing"
  | "plans"
  | "gateway"
  | "billing"
  | "analytics"
  | "trial";

function Shell() {
  const queryClientCtx = useQueryClient();
  const [tab, setTab] = useState<AdminTab>("users");
  const { data, isLoading, isFetching, refetch } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      refetchInterval: 60_000,
      retry: false,
    },
  });
  const user = (data as any)?.user ?? null;
  const logout = useLogoutMutation({
    onSuccess: () => {
      queryClientCtx.clear();
      refetch();
    },
  });

  useEffect(() => {
    document.title = "MaxiChat.App Backend";
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Memuat...
      </div>
    );
  }

  // Not signed in → show login form.
  if (!user) {
    return <Login />;
  }

  // Signed in but not admin → access denied with logout escape hatch.
  if (user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-sm w-full bg-card border border-border rounded-lg p-6 text-center space-y-4">
          <div className="mx-auto w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-destructive" />
          </div>
          <div>
            <h1 className="font-semibold">Akses ditolak</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Akun <span className="font-medium">{user.email}</span> bukan super admin.
            </p>
          </div>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="w-full h-9 rounded-md bg-muted text-foreground text-sm font-medium hover-elevate flex items-center justify-center gap-2"
            data-testid="logout-button"
          >
            {logout.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
            Keluar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-14 px-4 sm:px-6 border-b border-border flex items-center justify-between bg-card">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">MaxiChat.App Backend</div>
            <div className="text-[11px] text-muted-foreground leading-tight">
              Super admin
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {user.email}
          </span>
          {isFetching && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          )}
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            data-testid="logout-button"
            className="h-8 px-3 rounded-md bg-muted text-foreground text-xs font-medium flex items-center gap-1.5 hover-elevate"
          >
            {logout.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogOut className="w-3.5 h-3.5" />
            )}
            Keluar
          </button>
        </div>
      </header>
      <nav className="px-4 sm:px-6 border-b border-border bg-card flex items-center gap-1">
        {(
          [
            { key: "users", label: "Manajemen User", Icon: UsersIcon },
            { key: "trial", label: "Trial Monitor", Icon: Rocket },
            { key: "analytics", label: "Analitik Pendapatan", Icon: TrendingUp },
            { key: "billing", label: "Tagihan Tenant", Icon: Wallet },
            { key: "plans", label: "Paket & Add-on", Icon: Package },
            { key: "gateway", label: "Gateway Pembayaran", Icon: CreditCard },
            { key: "pricing", label: "Harga Pemakaian", Icon: Tag },
            { key: "usage", label: "Pemakaian Token", Icon: Cpu },
          ] as const
        ).map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            data-testid={`tab-${key}`}
            className={`h-10 px-3 -mb-px flex items-center gap-1.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>
      <main className="flex-1 p-4 sm:p-6">
        {tab === "users" && <Users currentUserId={user.id} />}
        {tab === "trial" && <TrialMonitor />}
        {tab === "analytics" && <Analytics />}
        {tab === "billing" && <Billing />}
        {tab === "plans" && <Plans />}
        {tab === "gateway" && <PaymentGateway />}
        {tab === "pricing" && <Pricing />}
        {tab === "usage" && <TokenUsage />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
