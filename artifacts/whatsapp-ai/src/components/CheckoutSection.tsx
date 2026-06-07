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
  Trash2,
  Minus,
  Plus,
  FileDown,
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

const KIND_LABEL: Record<string, string> = {
  plan: "Paket",
  addon: "Add-on",
  renewal: "Perpanjangan",
  cart: "Pembelian",
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

// A line in the local cart before checkout. Plans are always quantity 1 and at
// most one plan may be in the cart at a time.
type CartItem = {
  key: string;
  kind: "plan" | "addon";
  refId: number;
  name: string;
  unitPriceIdr: number;
  quantity: number;
  unitHint?: string;
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

  const [cart, setCart] = useState<CartItem[]>([]);
  const [manualResult, setManualResult] = useState<CheckoutResult | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const cartPlanId = useMemo(
    () => cart.find((c) => c.kind === "plan")?.refId ?? null,
    [cart]
  );
  const cartTotal = useMemo(
    () => cart.reduce((sum, c) => sum + c.unitPriceIdr * c.quantity, 0),
    [cart]
  );

  function inCart(key: string): CartItem | undefined {
    return cart.find((c) => c.key === key);
  }

  // A plan is single-select: adding one replaces any plan already in the cart
  // (the cart may hold at most one plan, always quantity 1).
  function addPlan(plan: Plan) {
    const key = `plan-${plan.id}`;
    setCart((prev) => {
      const withoutPlans = prev.filter((c) => c.kind !== "plan");
      return [
        {
          key,
          kind: "plan",
          refId: plan.id,
          name: plan.name,
          unitPriceIdr: plan.priceIdr,
          quantity: 1,
        },
        ...withoutPlans,
      ];
    });
  }

  function addAddon(addon: Addon, quantity: number) {
    const key = `addon-${addon.id}`;
    const q = Math.max(1, Math.floor(quantity || 1));
    setCart((prev) => {
      const existing = prev.find((c) => c.key === key);
      if (existing) {
        return prev.map((c) =>
          c.key === key ? { ...c, quantity: c.quantity + q } : c
        );
      }
      return [
        ...prev,
        {
          key,
          kind: "addon",
          refId: addon.id,
          name: addon.name,
          unitPriceIdr: addon.priceIdr,
          quantity: q,
          unitHint: `${fmtNum(addon.unitAmount)} ${
            ADDON_LABEL[addon.type] ?? addon.type
          }`,
        },
      ];
    });
  }

  function setCartQty(key: string, quantity: number) {
    const q = Math.max(1, Math.floor(quantity || 1));
    setCart((prev) => prev.map((c) => (c.key === key ? { ...c, quantity: q } : c)));
  }

  function removeFromCart(key: string) {
    setCart((prev) => prev.filter((c) => c.key !== key));
  }

  const checkout = useCreateCheckout({
    mutation: {
      onSuccess: (res: CheckoutResult) => {
        qc.invalidateQueries({ queryKey: getListMyPaymentsQueryKey() });
        setCart([]);
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
        toast({
          title: "Gagal memproses",
          description:
            err?.data?.error ?? "Tidak dapat membuat pesanan. Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  function doCheckout() {
    if (cart.length === 0) return;
    checkout.mutate({
      data: {
        items: cart.map((c) => ({
          kind: c.kind,
          refId: c.refId,
          quantity: c.quantity,
        })),
        successRedirectUrl: window.location.href,
      },
    });
  }

  async function downloadInvoice(p: PaymentRecord) {
    setDownloadingId(p.id);
    try {
      const res = await fetch(`/api/billing/payments/${p.id}/invoice`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-INV-${p.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Gagal mengunduh invoice",
        description: "Coba lagi sebentar lagi.",
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  const isManual = method?.activeProvider === "manual";

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
              : "Pembayaran otomatis via Xendit (VA / QRIS / e-wallet)."}{" "}
            Hanya 1 paket per pesanan.
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
              {plans.map((p) => {
                const selected = cartPlanId === p.id;
                return (
                  <div
                    key={p.id}
                    data-testid={`plan-card-${p.id}`}
                    className={`border rounded-lg p-4 flex flex-col gap-2 ${
                      selected
                        ? "border-primary ring-1 ring-primary/30 bg-primary/5"
                        : "border-border"
                    }`}
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
                      variant={selected ? "secondary" : "default"}
                      onClick={() => addPlan(p)}
                      data-testid={`buy-plan-${p.id}`}
                    >
                      {selected ? (
                        <>
                          <Check className="w-4 h-4" /> Dipilih
                        </>
                      ) : (
                        <>
                          <ShoppingCart className="w-4 h-4" /> Tambah ke
                          Keranjang
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
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
              {addons.map((a) => (
                <AddonRow key={a.id} addon={a} onAdd={addAddon} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-primary" />
            Keranjang
            {cart.length > 0 && (
              <Badge variant="secondary" data-testid="cart-count">
                {cart.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Tinjau pesanan Anda lalu lanjut ke pembayaran.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cart.length === 0 ? (
            <p
              className="text-sm text-muted-foreground py-2"
              data-testid="cart-empty"
            >
              Keranjang masih kosong. Tambahkan paket atau add-on di atas.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="divide-y divide-border">
                {cart.map((c) => (
                  <div
                    key={c.key}
                    data-testid={`cart-item-${c.key}`}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase"
                        >
                          {c.kind === "plan" ? "Paket" : "Add-on"}
                        </Badge>
                        {c.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {c.unitHint ? `${c.unitHint} · ` : ""}
                        {fmtRp(c.unitPriceIdr)}
                        {c.kind === "addon" ? " / unit" : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {c.kind === "addon" ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            onClick={() => setCartQty(c.key, c.quantity - 1)}
                            data-testid={`cart-dec-${c.key}`}
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </Button>
                          <Input
                            type="number"
                            min={1}
                            max={1000}
                            value={c.quantity}
                            onChange={(e) =>
                              setCartQty(c.key, Number(e.target.value))
                            }
                            className="w-16 h-8 text-center"
                            data-testid={`cart-qty-${c.key}`}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            onClick={() => setCartQty(c.key, c.quantity + 1)}
                            data-testid={`cart-inc-${c.key}`}
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          x1
                        </span>
                      )}
                      <div className="text-sm font-semibold tabular-nums w-28 text-right">
                        {fmtRp(c.unitPriceIdr * c.quantity)}
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive"
                        onClick={() => removeFromCart(c.key)}
                        data-testid={`cart-remove-${c.key}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <div className="text-sm text-muted-foreground">Total</div>
                <div
                  className="text-lg font-bold text-primary tabular-nums"
                  data-testid="cart-total"
                >
                  {fmtRp(cartTotal)}
                </div>
              </div>
              <Button
                className="w-full"
                disabled={checkout.isPending || cart.length === 0}
                onClick={doCheckout}
                data-testid="cart-checkout"
              >
                {checkout.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShoppingCart className="w-4 h-4" />
                )}
                Checkout {fmtRp(cartTotal)}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

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
                    <th className="py-2 pr-3 font-medium">Item</th>
                    <th className="py-2 pr-3 font-medium text-right">Jumlah</th>
                    <th className="py-2 pr-3 font-medium">Metode</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentList.map((p) => {
                    const st = PAY_STATUS[p.status] ?? {
                      label: p.status,
                      variant: "outline" as const,
                    };
                    const itemLabel =
                      p.lineItems && p.lineItems.length > 0
                        ? p.lineItems.length === 1
                          ? p.lineItems[0].name
                          : `${p.lineItems.length} item`
                        : KIND_LABEL[p.kind] ?? p.kind;
                    return (
                      <tr
                        key={p.id}
                        data-testid={`payment-row-${p.id}`}
                        className="border-b border-border/50"
                      >
                        <td className="py-2 pr-3 whitespace-nowrap text-xs">
                          {fmtDateTime(p.createdAt)}
                        </td>
                        <td className="py-2 pr-3">
                          <span title={itemLabel}>{itemLabel}</span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtRp(p.amountIdr)}
                        </td>
                        <td className="py-2 pr-3 capitalize">{p.provider}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </td>
                        <td className="py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7"
                              disabled={downloadingId === p.id}
                              onClick={() => downloadInvoice(p)}
                              data-testid={`invoice-pdf-${p.id}`}
                            >
                              {downloadingId === p.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <FileDown className="w-3.5 h-3.5" />
                              )}
                              PDF
                            </Button>
                            {p.provider === "xendit" && p.invoiceUrl && (
                              <a
                                href={p.invoiceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary inline-flex items-center gap-1 hover:underline"
                              >
                                Bayar <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
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

// One add-on row with a local quantity selector + "add to cart" action.
function AddonRow({
  addon,
  onAdd,
}: {
  addon: Addon;
  onAdd: (addon: Addon, quantity: number) => void;
}) {
  const [q, setQ] = useState(1);
  return (
    <div
      data-testid={`addon-row-${addon.id}`}
      className="flex flex-wrap items-center justify-between gap-3 py-3"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{addon.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {fmtNum(addon.unitAmount)} {ADDON_LABEL[addon.type] ?? addon.type} ·{" "}
          {fmtRp(addon.priceIdr)} / unit
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          max={1000}
          value={q}
          onChange={(e) => setQ(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          className="w-20 h-9"
          data-testid={`addon-qty-${addon.id}`}
        />
        <div className="text-sm font-semibold tabular-nums w-28 text-right">
          {fmtRp(addon.priceIdr * q)}
        </div>
        <Button
          size="sm"
          onClick={() => {
            onAdd(addon, q);
            setQ(1);
          }}
          data-testid={`buy-addon-${addon.id}`}
        >
          <ShoppingCart className="w-4 h-4" />
          Tambah ke Keranjang
        </Button>
      </div>
    </div>
  );
}
