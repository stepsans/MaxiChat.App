import { useState } from "react";
import type { ProductInterestItem } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Trophy, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRupiah, type PeriodKey } from "./format";

// Period options for the picker. A subset of the shared PeriodKey (no "custom").
type ProductPeriod = "today" | "7d" | "30d";

const PERIOD_OPTIONS: Array<{ id: ProductPeriod; label: string }> = [
  { id: "today", label: "Hari ini" },
  { id: "7d", label: "7 hari" },
  { id: "30d", label: "30 hari" },
];

const COLLAPSED_COUNT = 10;

// Top Produk Diminati (spec B.7). Aggregated from AI Pipeline analyses; the
// "Ada"/"Baru" badge reflects whether the requested product matched the tenant
// catalog. The period picker drives the product-interest query (refetch on
// change). Clicking a row drills into the Analisa tab filtered to that product.
export function TopProductsTable({
  rows,
  loading,
  period,
  onPeriodChange,
  onProductClick,
}: {
  rows: ProductInterestItem[] | undefined;
  loading: boolean;
  period: PeriodKey;
  // Optional: when provided, the section gains an interactive period picker and
  // row-click drill-down. Omitted on the global dashboard (read-only context).
  onPeriodChange?: (period: ProductPeriod) => void;
  onProductClick?: (product: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const all = rows ?? [];
  const visible = expanded ? all : all.slice(0, COLLAPSED_COUNT);
  const hasMore = all.length > COLLAPSED_COUNT;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Trophy className="h-4 w-4 text-amber-500" />
            Produk Paling Diminati
          </CardTitle>
          {/* Period segmented control (only when the host wires onPeriodChange) */}
          {onPeriodChange && (
          <div className="flex items-center gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onPeriodChange(opt.id)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                  period === opt.id
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : all.length === 0 ? (
          <p className="py-2 text-muted-foreground">
            Belum ada minat produk terdeteksi pada periode ini. Data muncul setelah AI Pipeline menganalisa percakapan.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produk</TableHead>
                  <TableHead className="text-right">Minat</TableHead>
                  <TableHead className="text-right">Estimasi Nilai</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r, i) => (
                  <TableRow
                    key={`${r.productInterest}-${i}`}
                    onClick={onProductClick ? () => onProductClick(r.productInterest) : undefined}
                    className={onProductClick ? "cursor-pointer" : undefined}
                    title={onProductClick ? `Lihat analisa untuk "${r.productInterest}"` : undefined}
                  >
                    <TableCell className="font-medium">{r.productInterest}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}x</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.totalEstimatedValue > 0 ? formatRupiah(r.totalEstimatedValue) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.productInCatalog ? (
                        <Badge variant="outline" className="border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400">
                          Ada
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                          Baru
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasMore && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {expanded ? (
                  <>
                    Tampilkan lebih sedikit <ChevronUp className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    Tampilkan lebih ({all.length - COLLAPSED_COUNT}) <ChevronDown className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
