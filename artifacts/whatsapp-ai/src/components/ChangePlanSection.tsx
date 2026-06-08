import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBillingCatalog,
  getGetBillingCatalogQueryKey,
  useGetMyQuota,
  getGetMyQuotaQueryKey,
  useGetBillingPaymentMethod,
  getGetBillingPaymentMethodQueryKey,
  useChangeMyPlan,
  useChangeMyQuota,
  getGetMyBillingQueryKey,
  getGetMyWalletQueryKey,
  getListMyPaymentsQueryKey,
  getListMyInvoicesQueryKey,
  type Plan,
  type Addon,
  type TenantQuotaInfo,
  type ProrationResult,
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
  ArrowUpDown,
  Package,
  Check,
  ArrowUp,
  ArrowDown,
  Loader2,
  Landmark,
  Copy,
  Sparkles,
  PlusCircle,
  Minus,
  Plus,
} from "lucide-react";

function fmtRp(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(n);
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

const ADDON_LABEL: Record<string, string> = {
  token: "token AI",
  channel: "channel",
  user_seat: "user",
};

// A pending plan switch awaiting the confirmation dialog.
type PendingPlan = {
  plan: Plan;
  direction: "up" | "down" | "same";
};

// A pending add-on top-up awaiting confirmation.
type PendingAddon = {
  addon: Addon;
  quantity: number;
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

export default function ChangePlanSection() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: catalog, isLoading: catalogLoading } = useGetBillingCatalog({
    query: { queryKey: getGetBillingCatalogQueryKey() },
  });
  const { data: quota, isLoading: quotaLoading } = useGetMyQuota({
    query: { queryKey: getGetMyQuotaQueryKey(), refetchInterval: 60_000 },
  });
  const { data: method } = useGetBillingPaymentMethod({
    query: { queryKey: getGetBillingPaymentMethodQueryKey() },
  });

  const plans: Plan[] = catalog?.plans ?? [];
  const addons: Addon[] = catalog?.addons ?? [];
  const q = quota as TenantQuotaInfo | undefined;
  const currentPlanId = q?.planId ?? null;
  const currentPlan = useMemo(
    () => plans.find((p) => p.id === currentPlanId) ?? null,
    [plans, currentPlanId]
  );

  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingAddon, setPendingAddon] = useState<PendingAddon | null>(null);
  // Manual transfer instructions surfaced when a prorated charge resolves to a
  // manual-gateway checkout.
  const [manual, setManual] = useState<ProrationResult["checkout"] | null>(null);

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: getGetMyQuotaQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyBillingQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
    qc.invalidateQueries({ queryKey: getListMyPaymentsQueryKey() });
    qc.invalidateQueries({ queryKey: getListMyInvoicesQueryKey() });
  }

  // Shared result handler for both change-plan and change-quota: the server
  // returns a ProrationResult whose `mode` drives what happens next.
  function handleResult(res: ProrationResult, what: "plan" | "addon") {
    invalidateAll();
    const subject = what === "plan" ? "Paket" : "Kuota";
    if (res.mode === "applied") {
      toast({
        title: "Perubahan diterapkan",
        description: `${subject} Anda telah diperbarui.`,
      });
      return;
    }
    if (res.mode === "credit") {
      toast({
        title: "Kredit ditambahkan",
        description: `Selisih ${fmtRp(
          res.creditIdr ?? 0
        )} telah dikreditkan ke saldo Anda dan perubahan langsung berlaku.`,
      });
      return;
    }
    // mode === "charge": branch on the embedded checkout.
    const checkout = res.checkout;
    if (!checkout) {
      toast({
        title: "Perubahan diproses",
        description: "Selesaikan pembayaran untuk mengaktifkan perubahan.",
      });
      return;
    }
    if (checkout.mode === "wallet") {
      toast({
        title: "Perubahan diterapkan",
        description:
          "Saldo kredit Anda menutupi biaya prorata, perubahan langsung berlaku.",
      });
      return;
    }
    if (checkout.mode === "xendit" && checkout.invoiceUrl) {
      window.location.href = checkout.invoiceUrl;
      return;
    }
    if (checkout.mode === "manual") {
      setManual(checkout);
      return;
    }
    // Unexpected payload (e.g. xendit without an invoiceUrl): the order exists
    // and is pending — point the user at their payment history rather than
    // failing silently.
    toast({
      title: "Perubahan menunggu pembayaran",
      description:
        "Pesanan dibuat namun tautan pembayaran tidak tersedia. Cek Riwayat Pembayaran untuk melanjutkan.",
      variant: "destructive",
    });
  }

  function onError(err: any) {
    toast({
      title: "Gagal memproses",
      description: err?.data?.error ?? "Tidak dapat memproses perubahan. Coba lagi.",
      variant: "destructive",
    });
  }

  const changePlan = useChangeMyPlan({
    mutation: {
      onSuccess: (res) => {
        setPendingPlan(null);
        handleResult(res, "plan");
      },
      onError,
    },
  });
  const changeQuota = useChangeMyQuota({
    mutation: {
      onSuccess: (res) => {
        setPendingAddon(null);
        handleResult(res, "addon");
      },
      onError,
    },
  });

  function pickPlan(plan: Plan) {
    if (plan.id === currentPlanId) return;
    let direction: PendingPlan["direction"] = "same";
    if (currentPlan) {
      if (plan.priceIdr > currentPlan.priceIdr) direction = "up";
      else if (plan.priceIdr < currentPlan.priceIdr) direction = "down";
    } else {
      direction = "up";
    }
    setPendingPlan({ plan, direction });
  }

  function confirmPlan() {
    if (!pendingPlan) return;
    changePlan.mutate({
      data: {
        planId: pendingPlan.plan.id,
        successRedirectUrl: window.location.href,
      },
    });
  }

  function confirmAddon() {
    if (!pendingAddon) return;
    changeQuota.mutate({
      data: {
        addonId: pendingAddon.addon.id,
        quantity: pendingAddon.quantity,
        successRedirectUrl: window.location.href,
      },
    });
  }

  const isManual = method?.activeProvider === "manual";
  const busy = changePlan.isPending || changeQuota.isPending;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4 text-primary" />
            Ganti Paket
          </CardTitle>
          <CardDescription>
            Pindah paket di tengah periode. Selisihnya dihitung prorata (sisa
            hari): <strong>naik paket</strong> menimbulkan tagihan prorata,{" "}
            <strong>turun paket</strong> mengembalikan selisih sebagai kredit
            saldo dan langsung berlaku.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalogLoading || quotaLoading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Belum ada paket tersedia. Hubungi admin.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {plans.map((p) => {
                const isCurrent = p.id === currentPlanId;
                const isUpgrade =
                  currentPlan != null && p.priceIdr > currentPlan.priceIdr;
                const isDowngrade =
                  currentPlan != null && p.priceIdr < currentPlan.priceIdr;
                return (
                  <div
                    key={p.id}
                    data-testid={`change-plan-card-${p.id}`}
                    className={`border rounded-lg p-4 flex flex-col gap-2 ${
                      isCurrent
                        ? "border-primary ring-1 ring-primary/30 bg-primary/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        <Package className="w-4 h-4 text-primary" />
                        {p.name}
                      </div>
                      {isCurrent && (
                        <Badge variant="default" className="text-[10px]">
                          Paket aktif
                        </Badge>
                      )}
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
                      variant={isCurrent ? "secondary" : "default"}
                      disabled={isCurrent || busy}
                      onClick={() => pickPlan(p)}
                      data-testid={`change-plan-btn-${p.id}`}
                    >
                      {isCurrent ? (
                        <>
                          <Check className="w-4 h-4" /> Paket Aktif
                        </>
                      ) : isUpgrade ? (
                        <>
                          <ArrowUp className="w-4 h-4" /> Naik ke paket ini
                        </>
                      ) : isDowngrade ? (
                        <>
                          <ArrowDown className="w-4 h-4" /> Turun ke paket ini
                        </>
                      ) : (
                        <>
                          <ArrowUpDown className="w-4 h-4" /> Pilih paket ini
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

      {/* Add-on top-up (change-quota) */}
      {addons.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <PlusCircle className="w-4 h-4 text-primary" />
              Tambah Kuota (Prorata)
            </CardTitle>
            <CardDescription>
              Tambah kuota (user, channel, atau token AI) untuk sisa periode
              berjalan. Biaya dihitung prorata sampai akhir periode.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {addons.map((a) => (
                <AddonRow
                  key={a.id}
                  addon={a}
                  busy={busy}
                  onTopUp={(qty) => setPendingAddon({ addon: a, quantity: qty })}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Confirm plan change */}
      <Dialog
        open={!!pendingPlan}
        onOpenChange={(o) => !o && !changePlan.isPending && setPendingPlan(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {pendingPlan?.direction === "down" ? (
                <ArrowDown className="w-5 h-5 text-primary" />
              ) : (
                <ArrowUp className="w-5 h-5 text-primary" />
              )}
              Konfirmasi Ganti Paket
            </DialogTitle>
            <DialogDescription>
              {pendingPlan?.direction === "down" ? (
                <>
                  Anda akan turun ke paket{" "}
                  <strong>{pendingPlan?.plan.name}</strong>. Selisih sisa hari
                  dari paket lama akan dikreditkan ke saldo Anda dan paket baru
                  langsung berlaku.
                </>
              ) : (
                <>
                  Anda akan pindah ke paket{" "}
                  <strong>{pendingPlan?.plan.name}</strong> (
                  {fmtRp(pendingPlan?.plan.priceIdr ?? 0)} /{" "}
                  {pendingPlan?.plan.durationDays} hari). Biaya prorata untuk
                  sisa hari akan ditagihkan; paket baru aktif setelah pembayaran
                  selesai{" "}
                  {isManual
                    ? "(transfer manual)."
                    : "(otomatis via Xendit, atau langsung jika saldo mencukupi)."}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={changePlan.isPending}
              onClick={() => setPendingPlan(null)}
            >
              Batal
            </Button>
            <Button
              disabled={changePlan.isPending}
              onClick={confirmPlan}
              data-testid="confirm-change-plan"
            >
              {changePlan.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Konfirmasi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm add-on top-up */}
      <Dialog
        open={!!pendingAddon}
        onOpenChange={(o) =>
          !o && !changeQuota.isPending && setPendingAddon(null)
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlusCircle className="w-5 h-5 text-primary" />
              Konfirmasi Tambah Kuota
            </DialogTitle>
            <DialogDescription>
              Tambah <strong>{pendingAddon?.quantity}</strong> ×{" "}
              <strong>{pendingAddon?.addon.name}</strong>. Biaya prorata untuk
              sisa periode akan ditagihkan{" "}
              {isManual
                ? "(transfer manual)."
                : "(otomatis via Xendit, atau langsung jika saldo mencukupi)."}{" "}
              Kuota aktif setelah pembayaran selesai.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={changeQuota.isPending}
              onClick={() => setPendingAddon(null)}
            >
              Batal
            </Button>
            <Button
              disabled={changeQuota.isPending}
              onClick={confirmAddon}
              data-testid="confirm-change-quota"
            >
              {changeQuota.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Konfirmasi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual transfer instructions (prorated charge via manual gateway) */}
      <Dialog open={!!manual} onOpenChange={(o) => !o && setManual(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Landmark className="w-5 h-5 text-primary" />
              Instruksi Transfer Manual
            </DialogTitle>
            <DialogDescription>
              Transfer sesuai nominal di bawah, lalu tunggu konfirmasi admin.
              Perubahan aktif otomatis setelah pembayaran diverifikasi.
            </DialogDescription>
          </DialogHeader>
          {manual && (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-border p-3 space-y-2">
                <Row label="Nominal">
                  <span className="font-bold text-primary tabular-nums">
                    {fmtRp(manual.amountIdr)}
                  </span>
                </Row>
                {manual.bankName && (
                  <Row label="Bank">{manual.bankName}</Row>
                )}
                {manual.bankAccountNumber && (
                  <Row label="No. Rekening">
                    <span className="flex items-center gap-2">
                      <span className="font-mono">
                        {manual.bankAccountNumber}
                      </span>
                      <CopyButton value={manual.bankAccountNumber} />
                    </span>
                  </Row>
                )}
                {manual.bankAccountHolder && (
                  <Row label="Atas Nama">{manual.bankAccountHolder}</Row>
                )}
                {manual.code && (
                  <Row label="Kode Pembayaran">
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{manual.code}</span>
                      <CopyButton value={manual.code} />
                    </span>
                  </Row>
                )}
              </div>
              {manual.manualInstructions && (
                <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {manual.manualInstructions}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setManual(null)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function AddonRow({
  addon,
  busy,
  onTopUp,
}: {
  addon: Addon;
  busy: boolean;
  onTopUp: (quantity: number) => void;
}) {
  const [qty, setQty] = useState(1);
  const clamped = Math.min(1000, Math.max(1, Math.floor(qty || 1)));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{addon.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {fmtNum(addon.unitAmount)} {ADDON_LABEL[addon.type] ?? addon.type} ·{" "}
          {fmtRp(addon.priceIdr)} / unit
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8"
            onClick={() => setQty(clamped - 1)}
            data-testid={`topup-dec-${addon.id}`}
          >
            <Minus className="w-3.5 h-3.5" />
          </Button>
          <Input
            type="number"
            min={1}
            max={1000}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="w-16 h-8 text-center"
            data-testid={`topup-qty-${addon.id}`}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8"
            onClick={() => setQty(clamped + 1)}
            data-testid={`topup-inc-${addon.id}`}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onTopUp(clamped)}
          data-testid={`topup-btn-${addon.id}`}
        >
          <PlusCircle className="w-4 h-4" /> Tambah
        </Button>
      </div>
    </div>
  );
}
