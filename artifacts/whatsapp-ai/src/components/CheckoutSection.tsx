import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBillingCatalog,
  getGetBillingCatalogQueryKey,
  useGetBillingPaymentMethod,
  getGetBillingPaymentMethodQueryKey,
  useListMyPayments,
  getListMyPaymentsQueryKey,
  useCreateCheckout,
  type Plan,
  type Addon,
  type CheckoutResult,
  type PaymentRecord,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ShoppingCart,
  Package,
  PlusCircle,
  ExternalLink,
  Copy,
  Check,
  Landmark,
  Loader2,
  Receipt,
} from "lucide-react";

function fmtRp(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(n);
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ADDON_LABEL: Record<string, string> = {
  token: "token AI",
  channel: "channel",
  user_seat: "user",
};

const PAY_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Menunggu", variant: "secondary" },
  paid: { label: "Lunas", variant: "default" },
  expired: { label: "Kedaluwarsa", variant: "outline" },
  failed: { label: "Gagal", variant: "destructive" },
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {}
        )
      }
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </Button>
  );
}

export default function CheckoutSection() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: catalog, isLoading: catalogLoading } = useGetBillingCatalog({
    query: { queryKey: getGetBillingCatalogQueryKey() },
  });
  const { data: method } = useGetBillingPaymentMethod({
    query: { queryKey: getGetBillingPaymentMethodQueryKey() },
  });
  const { data: payments, isLoading: paymentsLoading } = useListMyPayments({
    query: {
      queryKey: getListMyPaymentsQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const plans: Plan[] = catalog?.plans ?? [];
  const addons: Addon[] = catalog?.addons ?? [];
  const paymentList: PaymentRecord[] = (payments as PaymentRecord[]) ?? [];

  const [qty, setQty] = useState<Record<number, number>>({});
  const [manualResult, setManualResult] = useState<CheckoutResult | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const checkout = useCreateCheckout({
    mutation: {
      onSuccess: (res: CheckoutResult) => {
        setPendingId(null);
        qc.invalidateQueries({ queryKey: getListMyPaymentsQueryKey() });
        if (res.mode === "xendit" && res.invoiceUrl) {
          window.location.href = res.invoiceUrl;
          return;
        }
        if (res.mode === "manual") {
          setManualResult(res);
          return;
        }
        toast({
          title: "Checkout dibuat",
          description: "Pesanan Anda telah dibuat.",
        });
      },
      onError: (err: any) => {
        setPendingId(null);
        toast({
          title: "Gagal memproses",
          description:
            err?.data?.error ?? "Tidak dapat membuat pesanan. Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  function buyPlan(plan: Plan) {
    setPendingId(`plan-${plan.id}`);
    checkout.mutate({
      data: {
        kind: "plan",
        refId: plan.id,
        successRedirectUrl: window.location.href,
      },
    });
  }

  function buyAddon(addon: Addon) {
    const q = Math.max(1, Math.floor(qty[addon.id] ?? 1));
    setPendingId(`addon-${addon.id}`);
    checkout.mutate({
      data: {
        kind: "addon",
        refId: addon.id,
        quantity: q,
        successRedirectUrl: window.location.href,
      },
    });
  }

  const isManual = method?.activeProvider === "manual";

  const hasCatalog = useMemo(
    () => plans.length > 0 || addons.length > 0,
    [plans.length, addons.length]
  );

  return (
    <>
      {/* Plans */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-primary" />
            Pilih Paket
          </CardTitle>
          <CardDescription>
            {isManual
              ? "Pembayaran via transfer bank manual. Setelah checkout, ikuti instruksi transfer."
              : "Pembayaran otomatis via Xendit (VA / QRIS / e-wallet)."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalogLoading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Belum ada paket tersedia. Hubungi admin.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {plans.map((p) => (
                <div
                  key={p.id}
                  data-testid={`plan-card-${p.id}`}
                  className="border border-border rounded-lg p-4 flex flex-col gap-2"
                >
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <Package className="w-4 h-4 text-primary" />
                    {p.name}
                  </div>
                  {p.description && (
                    <p className="text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}
                  <div className="text-lg font-bold text-primary tabular-nums">
                    {fmtRp(p.priceIdr)}
                    <span className="text-xs font-normal text-muted-foreground">
                      {" "}
                      / {p.durationDays} hari
                    </span>
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-0.5 mt-1">
                    <li>{fmtNum(p.quotaUsers)} user tim</li>
                    <li>{fmtNum(p.quotaChannels)} channel</li>
                    <li>{fmtNum(p.quotaTokens)} token AI</li>
                  </ul>
                  <Button
                    className="mt-auto"
                    size="sm"
                    disabled={checkout.isPending}
                    onClick={() => buyPlan(p)}
                    data-testid={`buy-plan-${p.id}`}
                  >
                    {pendingId === `plan-${p.id}` ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ShoppingCart className="w-4 h-4" />
                    )}
                    Beli paket
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add-ons */}
      {addons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PlusCircle className="w-4 h-4 text-primary" />
              Add-on / Top-up
            </CardTitle>
            <CardDescription>
              Tambahkan kuota di luar paket (user, channel, atau token AI).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {addons.map((a) => {
                const q = Math.max(1, Math.floor(qty[a.id] ?? 1));
                return (
                  <div
                    key={a.id}
                    data-testid={`addon-row-${a.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {fmtNum(a.unitAmount)} {ADDON_LABEL[a.type] ?? a.type} ·{" "}
                        {fmtRp(a.priceIdr)} / unit
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        value={q}
                        onChange={(e) =>
                          setQty((prev) => ({
                            ...prev,
                            [a.id]: Math.max(1, Number(e.target.value) || 1),
                          }))
                        }
                        className="w-20 h-9"
                        data-testid={`addon-qty-${a.id}`}
                      />
                      <div className="text-sm font-semibold tabular-nums w-28 text-right">
                        {fmtRp(a.priceIdr * q)}
                      </div>
                      <Button
                        size="sm"
                        disabled={checkout.isPending}
                        onClick={() => buyAddon(a)}
                        data-testid={`buy-addon-${a.id}`}
                      >
                        {pendingId === `addon-${a.id}` ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ShoppingCart className="w-4 h-4" />
                        )}
                        Beli
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="w-4 h-4 text-primary" />
            Riwayat Pembayaran
          </CardTitle>
          <CardDescription>
            Daftar pesanan dan statusnya. Pesanan manual aktif setelah admin
            menandai LUNAS.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {paymentsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : paymentList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              Belum ada transaksi.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Tanggal</th>
                    <th className="py-2 pr-3 font-medium">Jenis</th>
                    <th className="py-2 pr-3 font-medium text-right">Jumlah</th>
                    <th className="py-2 pr-3 font-medium">Metode</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentList.map((p) => {
                    const st = PAY_STATUS[p.status] ?? {
                      label: p.status,
                      variant: "outline" as const,
                    };
                    return (
                      <tr
                        key={p.id}
                        data-testid={`payment-row-${p.id}`}
                        className="border-b border-border/50"
                      >
                        <td className="py-2 pr-3 whitespace-nowrap text-xs">
                          {fmtDateTime(p.createdAt)}
                        </td>
                        <td className="py-2 pr-3 capitalize">{p.kind}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtRp(p.amountIdr)}
                        </td>
                        <td className="py-2 pr-3 capitalize">{p.provider}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </td>
                        <td className="py-2 text-xs">
                          {p.provider === "xendit" && p.invoiceUrl ? (
                            <a
                              href={p.invoiceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary inline-flex items-center gap-1 hover:underline"
                            >
                              Invoice <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : (
                            <span className="font-mono">
                              {p.externalId ?? "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual transfer instructions */}
      <Dialog
        open={!!manualResult}
        onOpenChange={(o) => !o && setManualResult(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Landmark className="w-5 h-5 text-primary" />
              Instruksi Transfer Manual
            </DialogTitle>
            <DialogDescription>
              Transfer sesuai nominal di bawah, lalu tunggu konfirmasi admin.
              Langganan aktif otomatis setelah pembayaran diverifikasi.
            </DialogDescription>
          </DialogHeader>
          {manualResult && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
                <span className="text-muted-foreground text-xs">Nominal</span>
                <span className="font-bold text-primary tabular-nums">
                  {fmtRp(manualResult.amountIdr)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
                <span className="text-muted-foreground text-xs">Bank</span>
                <span className="font-medium">
                  {manualResult.bankName ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
                <span className="text-muted-foreground text-xs">No. Rekening</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono font-medium">
                    {manualResult.bankAccountNumber ?? "—"}
                  </span>
                  {manualResult.bankAccountNumber && (
                    <CopyButton value={manualResult.bankAccountNumber} />
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2">
                <span className="text-muted-foreground text-xs">
                  Atas Nama
                </span>
                <span className="font-medium">
                  {manualResult.bankAccountHolder ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 border border-primary/40 bg-primary/5 rounded-md px-3 py-2">
                <span className="text-muted-foreground text-xs">
                  Kode Pembayaran
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono font-semibold">
                    {manualResult.code ?? manualResult.externalId ?? "—"}
                  </span>
                  {(manualResult.code ?? manualResult.externalId) && (
                    <CopyButton
                      value={
                        (manualResult.code ?? manualResult.externalId) as string
                      }
                    />
                  )}
                </span>
              </div>
              {manualResult.manualInstructions && (
                <p className="text-xs text-muted-foreground border-t border-border pt-2">
                  {manualResult.manualInstructions}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Cantumkan Kode Pembayaran pada berita transfer agar mudah
                diverifikasi.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setManualResult(null)}>Mengerti</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
