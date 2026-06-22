import { useLocation } from "wouter";
import type { ProductInterestItem } from "@workspace/api-client-react";
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
import { Lightbulb, Plus, Download } from "lucide-react";
import { formatRupiah, PERIOD_LABEL, type PeriodKey } from "./format";

// Peluang Produk Baru (spec C.7). Surfaces products customers asked for that are
// NOT in the tenant catalog (product_in_catalog=false). Hidden entirely when
// there's nothing unmatched. "Tambahkan ke Katalog" deep-links to the product
// form pre-filled; Export CSV downloads the full unmatched list.
export function NewProductOpportunity({
  rows,
  loading,
  totalUnmatchedValue,
  period,
}: {
  rows: ProductInterestItem[] | undefined;
  loading: boolean;
  totalUnmatchedValue: number;
  period: PeriodKey;
}) {
  const [, navigate] = useLocation();

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
  // Render nothing when every requested product already exists in the catalog.
  if (items.length === 0) return null;

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
            {items.map((r, i) => (
              <TableRow key={`${r.productInterest}-${i}`}>
                <TableCell className="font-medium">{r.productInterest}</TableCell>
                <TableCell className="text-right tabular-nums">{r.count}x</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.totalEstimatedValue > 0 ? formatRupiah(r.totalEstimatedValue) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => navigate(`/products?prefill_name=${encodeURIComponent(r.productInterest)}`)}
                  >
                    <Plus className="h-3 w-3" /> Tambah
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-500/10 px-3 py-2">
          <span className="text-sm font-medium">
            💰 Total potensi belum terlayani: {formatRupiah(totalUnmatchedValue)}
          </span>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={exportCsv}>
            <Download className="h-3 w-3" /> Export CSV
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
