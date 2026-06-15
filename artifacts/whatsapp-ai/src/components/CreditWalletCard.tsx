import {
  useGetMyCreditWallet,
  getGetMyCreditWalletQueryKey,
  useGetMyCreditWalletUsage,
  getGetMyCreditWalletUsageQueryKey,
  type CreditWalletView,
  type CreditUsageEvent,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Zap, AlertTriangle, Ban } from "lucide-react";

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return null as unknown as string;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

const ENGINE_LABEL: Record<string, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
};

const NOTICE_STYLE: Record<
  string,
  { cls: string; Icon: typeof AlertTriangle; text: string } | null
> = {
  ok: null,
  low: {
    cls: "bg-yellow-500/10 border-yellow-500/40 text-yellow-600 dark:text-yellow-400",
    Icon: AlertTriangle,
    text: "Kredit AI menipis — lakukan top-up agar balasan AI tidak terhenti.",
  },
  critical: {
    cls: "bg-destructive/10 border-destructive/40 text-destructive",
    Icon: AlertTriangle,
    text: "Kredit AI kritis — segera top-up.",
  },
  empty: {
    cls: "bg-destructive/10 border-destructive/50 text-destructive",
    Icon: Ban,
    text: "Kredit AI habis — balasan AI otomatis dijeda. Chat manual tetap aktif.",
  },
};

export default function CreditWalletCard({ onTopup }: { onTopup?: () => void }) {
  const { data, isLoading } = useGetMyCreditWallet({
    query: { queryKey: getGetMyCreditWalletQueryKey(), refetchInterval: 60_000, retry: false },
  });
  const { data: usageData } = useGetMyCreditWalletUsage(
    { days: 30 },
    { query: { queryKey: getGetMyCreditWalletUsageQueryKey({ days: 30 }), retry: false } },
  );

  const w = data as CreditWalletView | undefined;
  const usage = (usageData as CreditUsageEvent[] | undefined) ?? [];
  const pct = w?.percentRemaining ?? 100;
  const notice = NOTICE_STYLE[w?.notice ?? "ok"] ?? null;
  const grantExpiry = fmtDate(w?.grantExpiresAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          Kredit AI
        </CardTitle>
        <CardDescription>
          Saldo prabayar untuk balasan & analisis AI. Jatah paket dipakai lebih dulu, lalu kredit top-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && (
          <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${notice.cls}`} data-testid="credit-notice">
            <notice.Icon className="w-4 h-4 shrink-0" />
            <span className="flex-1">{notice.text}</span>
            {onTopup && (
              <button
                type="button"
                onClick={onTopup}
                className="text-xs font-semibold underline underline-offset-2 whitespace-nowrap"
              >
                Top-up
              </button>
            )}
          </div>
        )}

        {/* Balance + runway */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Total sisa kredit</div>
            {isLoading ? (
              <Skeleton className="h-8 w-28 mt-1" />
            ) : (
              <div className="text-2xl font-bold tabular-nums text-primary" data-testid="credit-total">
                {fmtNum(w?.total ?? 0)}
              </div>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {w?.estDaysLeft != null ? <>Estimasi habis ~{w.estDaysLeft} hari</> : <>Estimasi habis —</>}
            <div className="mt-0.5">Sisa {pct}%</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full ${
              w?.notice === "empty" || w?.notice === "critical"
                ? "bg-destructive"
                : w?.notice === "low"
                  ? "bg-yellow-500"
                  : "bg-primary"
            }`}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>

        {/* Two buckets */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Jatah paket</div>
            <div className="font-semibold tabular-nums" data-testid="credit-grant">{fmtNum(w?.grantBalance ?? 0)}</div>
            {grantExpiry && <div className="text-[11px] text-muted-foreground mt-0.5">Hangus {grantExpiry}</div>}
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">Top-up (awet)</div>
            <div className="font-semibold tabular-nums" data-testid="credit-paid">{fmtNum(w?.paidBalance ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Tidak hangus</div>
          </div>
        </div>

        {onTopup && (
          <button
            type="button"
            onClick={onTopup}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            data-testid="credit-topup"
          >
            <Zap className="w-4 h-4" /> Top-up Kredit AI
          </button>
        )}

        {/* Usage history */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Pemakaian terbaru</div>
          {usage.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="credit-usage-empty">Belum ada pemakaian AI.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Waktu</th>
                    <th className="py-2 pr-3 font-medium">Mesin</th>
                    <th className="py-2 pr-3 font-medium text-right">Token</th>
                    <th className="py-2 font-medium text-right">Kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.slice(0, 15).map((u, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtDateTime(u.createdAt)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {u.engine ? (ENGINE_LABEL[u.engine] ?? u.engine) : "—"}
                        {u.model ? <span className="text-muted-foreground"> · {u.model}</span> : null}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-xs">{fmtNum(u.totalTokens)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtNum(u.creditsCharged)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
