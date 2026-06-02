import {
  useGetMyAiUsage,
  getGetMyAiUsageQueryKey,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { Cpu, MessageSquareText, Sparkles, ShieldAlert } from "lucide-react";

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function Usage() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.usage.canView;

  const { data, isLoading } = useGetMyAiUsage({
    query: {
      queryKey: getGetMyAiUsageQueryKey(),
      refetchInterval: 30_000,
      enabled: canView,
      retry: false,
    },
  });

  // Route is unguarded — self-guard so a user without usage.view who navigates
  // here directly gets a clear message instead of a 403-driven blank state.
  if (!permLoading && !canView) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
            <CardDescription>
              Anda tidak memiliki izin untuk melihat pemakaian token AI.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const loading = permLoading || isLoading;

  const stats = [
    {
      label: "Total Token",
      value: data?.totalTokens ?? 0,
      Icon: Cpu,
      accent: "text-primary",
    },
    {
      label: "Token Prompt",
      value: data?.promptTokens ?? 0,
      Icon: MessageSquareText,
      accent: "text-foreground",
    },
    {
      label: "Token Jawaban",
      value: data?.completionTokens ?? 0,
      Icon: Sparkles,
      accent: "text-foreground",
    },
    {
      label: "Jumlah Panggilan AI",
      value: data?.requestCount ?? 0,
      Icon: MessageSquareText,
      accent: "text-foreground",
    },
  ];

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Pemakaian Token AI
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ringkasan pemakaian token AI akun Anda untuk periode berjalan. Anda
          memakai kuota token milik akun Anda sendiri.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Periode Berjalan</CardTitle>
          <CardDescription>
            {loading ? (
              <Skeleton className="h-4 w-64 mt-1" />
            ) : (
              <>
                {fmtDate(data?.periodStart)} – {fmtDate(data?.periodEnd)}{" "}
                <span className="text-muted-foreground">
                  (mengikuti tanggal bergabung: {fmtDate(data?.joinedAt)})
                </span>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((s) => (
              <div
                key={s.label}
                data-testid={`usage-stat-${s.label}`}
                className="rounded-lg border border-border bg-card/50 p-4"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wide">
                  <s.Icon className="w-3.5 h-3.5" />
                  {s.label}
                </div>
                {loading ? (
                  <Skeleton className="h-8 w-20 mt-2" />
                ) : (
                  <div
                    className={`text-2xl font-semibold mt-1.5 tabular-nums ${s.accent}`}
                  >
                    {fmtNum(s.value)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Token mulai dihitung sejak fitur ini aktif — pemakaian sebelum itu tidak
        tersedia. Periode berikutnya otomatis dimulai pada tanggal yang sama
        setiap bulan.
      </p>
    </div>
  );
}
