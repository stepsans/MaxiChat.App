import { useState } from "react";
import { useGetAiInsights, getGetAiInsightsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, RefreshCw, Share2, AlertTriangle } from "lucide-react";

type InsightPeriod = "today" | "7d" | "30d";

interface NarrativeContent {
  criticalIssue?: string | null;
  opportunity?: string | null;
  positive?: string | null;
  totalChatsAnalyzed?: number;
}

export function AiInsightCard({ period }: { period: InsightPeriod }) {
  const { toast } = useToast();
  const [refresh, setRefresh] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const params = { type: "narrative" as const, period, ...(refresh ? { refresh: true } : {}) };
  const { data, isLoading, isFetching, refetch } = useGetAiInsights(params, {
    query: { queryKey: getGetAiInsightsQueryKey(params) },
  });

  const content = (data?.content ?? {}) as NarrativeContent;
  const err = data?.error;

  const shareText = [
    "✨ Insight AI — Laporan & Jadwal",
    content.criticalIssue ? `🔴 Mendesak: ${content.criticalIssue}` : null,
    content.opportunity ? `🟡 Peluang: ${content.opportunity}` : null,
    content.positive ? `🟢 Berjalan baik: ${content.positive}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Card className="border-purple-200 dark:border-purple-900/60">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-purple-500" />
            Insight AI
            {data?.fromCache && <span className="text-xs font-normal text-muted-foreground">(tersimpan)</span>}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={isFetching}
              onClick={() => {
                setRefresh(true);
                void refetch();
              }}
              title="Muat ulang"
            >
              <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </Button>
            {!err && (content.criticalIssue || content.opportunity || content.positive) && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShareOpen(true)} title="Bagikan">
                <Share2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {isLoading ? (
          <>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-2/3" />
          </>
        ) : err ? (
          <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-muted-foreground">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>{err}</span>
          </div>
        ) : (
          <>
            {data?.content && typeof content.totalChatsAnalyzed === "number" && (
              <p className="text-xs text-muted-foreground">
                AI membaca {content.totalChatsAnalyzed} percakapan dan menemukan:
              </p>
            )}
            <InsightLine dot="🔴" label="Masalah mendesak" text={content.criticalIssue} />
            <InsightLine dot="🟡" label="Peluang" text={content.opportunity} />
            <InsightLine dot="🟢" label="Berjalan baik" text={content.positive} />
            {!content.criticalIssue && !content.opportunity && !content.positive && (
              <p className="text-muted-foreground">Belum ada insight untuk periode ini.</p>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bagikan insight ke tim</DialogTitle>
          </DialogHeader>
          <textarea
            readOnly
            value={shareText}
            className="h-40 w-full resize-none rounded-md border border-border bg-muted/40 p-3 text-sm"
          />
          <DialogFooter>
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(shareText);
                toast({ title: "Teks insight disalin." });
              }}
            >
              Salin teks
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function InsightLine({ dot, label, text }: { dot: string; label: string; text?: string | null }) {
  if (!text) return null;
  return (
    <p className="leading-relaxed">
      <span className="mr-1">{dot}</span>
      <span className="font-medium">{label}:</span> {text}
    </p>
  );
}
