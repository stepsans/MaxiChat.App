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
import { Trophy } from "lucide-react";
import { formatRupiah, PERIOD_LABEL, type PeriodKey } from "./format";

// Top Produk Diminati (spec C.7). Aggregated from AI Pipeline analyses; the
// "Ada"/"Baru" badge reflects whether the requested product matched the tenant
// catalog. Period is driven by the global picker — shown here for context only.
export function TopProductsTable({
  rows,
  loading,
  period,
}: {
  rows: ProductInterestItem[] | undefined;
  loading: boolean;
  period: PeriodKey;
}) {
  const top = (rows ?? []).slice(0, 10);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Trophy className="h-4 w-4 text-amber-500" />
          Produk Paling Diminati
          <span className="text-xs font-normal text-muted-foreground">· {PERIOD_LABEL[period]}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : top.length === 0 ? (
          <p className="py-2 text-muted-foreground">
            Belum ada minat produk terdeteksi pada periode ini. Data muncul setelah AI Pipeline menganalisa percakapan.
          </p>
        ) : (
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
              {top.map((r, i) => (
                <TableRow key={`${r.productInterest}-${i}`}>
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
        )}
      </CardContent>
    </Card>
  );
}
