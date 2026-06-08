import { useState } from "react";
import {
  useListMyInvoices,
  getListMyInvoicesQueryKey,
  useGetMyInvoice,
  getGetMyInvoiceQueryKey,
  type InvoiceRecord,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FileText, FileDown, Loader2, Eye } from "lucide-react";

function fmtRp(n: number): string {
  return "Rp " + new Intl.NumberFormat("id-ID").format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const INV_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  open: { label: "Terbuka", variant: "secondary" },
  paid: { label: "Lunas", variant: "default" },
  void: { label: "Batal", variant: "outline" },
};

const LINE_TYPE_LABEL: Record<string, string> = {
  plan: "Paket",
  addon: "Add-on",
  token_booster: "Token AI",
  seat: "User",
  channel: "Channel",
  storage: "Penyimpanan",
  proration_credit: "Kredit proporsional",
  proration_charge: "Biaya proporsional",
  usage: "Pemakaian",
  other: "Lainnya",
};

export default function InvoiceHistory() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const { data, isLoading, isError } = useListMyInvoices({
    query: {
      queryKey: getListMyInvoicesQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const invoices: InvoiceRecord[] = data ?? [];

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
  } = useGetMyInvoice(selectedId ?? 0, {
    query: {
      queryKey: getGetMyInvoiceQueryKey(selectedId ?? 0),
      enabled: selectedId != null,
    },
  });

  async function downloadPdf(inv: InvoiceRecord) {
    // The PDF is generated per payment; an invoice carries its source payment id.
    if (inv.paymentId == null) {
      toast({
        title: "PDF tidak tersedia",
        description: "Invoice ini tidak memiliki dokumen pembayaran.",
        variant: "destructive",
      });
      return;
    }
    setDownloadingId(inv.id);
    try {
      const res = await fetch(
        `/api/billing/payments/${inv.paymentId}/invoice`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${inv.invoiceNumber}.pdf`;
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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            Riwayat Tagihan
          </CardTitle>
          <CardDescription>
            Daftar invoice resmi akun Anda. Klik untuk melihat rincian item.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : isError ? (
            <p
              className="text-sm text-destructive py-2"
              data-testid="invoices-error"
            >
              Gagal memuat riwayat tagihan. Coba muat ulang halaman.
            </p>
          ) : invoices.length === 0 ? (
            <p
              className="text-sm text-muted-foreground py-2"
              data-testid="invoices-empty"
            >
              Belum ada invoice.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">No. Invoice</th>
                    <th className="py-2 pr-3 font-medium">Tanggal</th>
                    <th className="py-2 pr-3 font-medium text-right">Total</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const st = INV_STATUS[inv.status] ?? {
                      label: inv.status,
                      variant: "outline" as const,
                    };
                    return (
                      <tr
                        key={inv.id}
                        data-testid={`invoice-row-${inv.id}`}
                        className="border-b border-border/50"
                      >
                        <td className="py-2 pr-3 whitespace-nowrap font-medium">
                          {inv.invoiceNumber}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-xs">
                          {fmtDate(inv.issuedAt)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtRp(inv.totalIdr)}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </td>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7"
                              onClick={() => setSelectedId(inv.id)}
                              data-testid={`invoice-view-${inv.id}`}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Lihat
                            </Button>
                            {inv.paymentId != null && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7"
                                disabled={downloadingId === inv.id}
                                onClick={() => downloadPdf(inv)}
                                data-testid={`invoice-pdf-${inv.id}`}
                              >
                                {downloadingId === inv.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <FileDown className="w-3.5 h-3.5" />
                                )}
                                PDF
                              </Button>
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

      {/* Invoice detail with line items */}
      <Dialog
        open={selectedId != null}
        onOpenChange={(o) => !o && setSelectedId(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              {detail?.invoice.invoiceNumber ?? "Invoice"}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `Diterbitkan ${fmtDate(detail.invoice.issuedAt)}`
                : "Memuat rincian invoice…"}
            </DialogDescription>
          </DialogHeader>

          {detailError ? (
            <p
              className="text-sm text-destructive py-4"
              data-testid="invoice-detail-error"
            >
              Gagal memuat rincian invoice. Tutup dan coba lagi.
            </p>
          ) : detailLoading || !detail ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-3 font-medium">Item</th>
                      <th className="py-2 pr-3 font-medium text-right">Qty</th>
                      <th className="py-2 pr-3 font-medium text-right">Harga</th>
                      <th className="py-2 font-medium text-right">Jumlah</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lineItems.map((li) => (
                      <tr
                        key={li.id}
                        data-testid={`invoice-line-${li.id}`}
                        className="border-b border-border/50"
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium">{li.description}</div>
                          <div className="text-xs text-muted-foreground">
                            {LINE_TYPE_LABEL[li.lineType] ?? li.lineType}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {li.quantity}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtRp(li.unitPriceIdr)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmtRp(li.amountIdr)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1 border-t border-border pt-3">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">
                    {fmtRp(detail.invoice.subtotalIdr)}
                  </span>
                </div>
                {detail.invoice.taxIdr > 0 && (
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Pajak</span>
                    <span className="tabular-nums">
                      {fmtRp(detail.invoice.taxIdr)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between font-semibold pt-1">
                  <span>Total</span>
                  <span
                    className="text-lg text-primary tabular-nums"
                    data-testid="invoice-detail-total"
                  >
                    {fmtRp(detail.invoice.totalIdr)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
