import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProductInterestItem } from "@workspace/api-client-react";
import {
  useIgnoreAiPipelineProduct,
  getGetAiPipelineProductInterestQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Lightbulb, Trash2, Download, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatRupiah, PERIOD_LABEL, type PeriodKey } from "./format";

const INITIAL_ROWS = 10;

// Peluang Produk Baru (spec B.7). Surfaces products customers asked for that are
// NOT in the tenant catalog (product_in_catalog=false). Hidden entirely when
// there's nothing unmatched. The 🗑 button dismisses a product so it never
// reappears here (persisted to ai_pipeline_ignored_products) — by design there
// is NO "Tambahkan ke Katalog" action; the owner decides that separately.
// Export CSV downloads the full unmatched list.
export function NewProductOpportunity({
  pipelineId,
  rows,
  loading,
  totalUnmatchedValue,
  period,
}: {
  pipelineId: number;
  rows: ProductInterestItem[] | undefined;
  loading: boolean;
  totalUnmatchedValue: number;
  period: PeriodKey;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<ProductInterestItem | null>(null);

  const ignore = useIgnoreAiPipelineProduct({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAiPipelineProductInterestQueryKey(pipelineId) });
      },
      onError: () => {
        toast({
          title: "Gagal menghapus",
          description: "Produk tidak bisa dihapus dari daftar. Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Peluang Produk Baru</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  const items = rows ?? [];
  // Render nothing when every requested product already exists in the catalog
  // or has been dismissed.
  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, INITIAL_ROWS);
  const hiddenCount = items.length - visible.length;

  function exportCsv() {
    const header = ["Produk Diminta Customer", "Frekuensi", "Estimasi Nilai (Rp)"];
    const lines = items.map((r) =>
      [r.productInterest, String(r.count), String(r.totalEstimatedValue)]
        .map((c) => `"${c.replace(/"/g, '""')}"`)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `peluang-produk-baru-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function confirmIgnore() {
    if (!pending) return;
    const productInterest = pending.productInterest;
    setPending(null);
    ignore.mutate({ id: pipelineId, data: { productInterest } });
  }

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          Peluang Produk Baru
          <span className="text-xs font-normal text-muted-foreground">· {PERIOD_LABEL[period]}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Customer meminta produk yang belum ada di katalog Anda.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produk Diminta Customer</TableHead>
              <TableHead className="text-right">Frekuensi</TableHead>
              <TableHead className="text-right">Est. Nilai</TableHead>
              <TableHead className="text-right">Aksi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r, i) => (
              <TableRow key={`${r.productInterest}-${i}`}>
                <TableCell className="font-medium">{r.productInterest}</TableCell>
                <TableCell className="text-right tabular-nums">{r.count}x</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.totalEstimatedValue > 0 ? formatRupiah(r.totalEstimatedValue) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Hapus ${r.productInterest} dari daftar peluang`}
                    disabled={ignore.isPending}
                    onClick={() => setPending(r)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {hiddenCount > 0 && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setExpanded(true)}
            >
              <ChevronDown className="h-3 w-3" /> Show more ({hiddenCount})
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-500/10 px-3 py-2">
          <span className="text-sm font-medium">
            💰 Total potensi belum terlayani: {formatRupiah(totalUnmatchedValue)}
          </span>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={exportCsv}>
            <Download className="h-3 w-3" /> Export CSV
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus dari daftar peluang?</AlertDialogTitle>
            <AlertDialogDescription>
              Hapus "{pending?.productInterest}" dari daftar peluang? Produk ini tidak akan
              muncul lagi meski customer kembali menanyakannya.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={confirmIgnore}>Hapus</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
