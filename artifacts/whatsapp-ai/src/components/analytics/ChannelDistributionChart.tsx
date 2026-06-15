import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChannelBreakdownItem } from "@workspace/api-client-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

// Brand-ish colors per channel kind.
const TYPE_COLOR: Record<string, string> = {
  whatsapp: "hsl(142,71%,40%)",
  instagram: "hsl(280,80%,60%)",
  telegram: "hsl(210,90%,55%)",
};

export function ChannelDistributionChart({
  data,
  loading,
}: {
  data: ChannelBreakdownItem[] | undefined;
  loading?: boolean;
}) {
  const rows = (data ?? []).map((c) => ({ name: c.channelName || c.type, value: c.count, type: c.type }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Distribusi per channel</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-56 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Belum ada chat pada periode ini.</p>
        ) : (
          <ResponsiveContainer width="100%" height={224}>
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-muted" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={TYPE_COLOR[r.type] ?? "hsl(210,9%,55%)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
