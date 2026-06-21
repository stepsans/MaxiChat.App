import { Link } from "wouter";
import { Download, Printer, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDashboardDrill, type DashboardRange, type DrillRow } from "@/hooks/useDashboard";

const LEAD_BADGE: Record<string, { label: string; cls: string }> = {
  lead: { label: "Lead", cls: "bg-success/15 text-success" },
  not_lead: { label: "Not Lead", cls: "bg-muted text-muted-foreground" },
  unknown: { label: "Unknown", cls: "bg-muted text-muted-foreground" },
};

// Build a CSV string from drill rows and trigger a client-side download — no
// backend round-trip (the rows are already loaded). Quotes per RFC 4180.
function exportRowsCsv(title: string, rows: DrillRow[]): void {
  const headers = ["Nama", "Telepon", "Status", "Lead Status", "Pesan Terakhir", "Waktu"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [r.contactName, r.phoneNumber, r.status, r.leadStatus, r.lastMessage, r.lastMessageAt]
        .map(esc)
        .join(",")
    ),
  ];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, `${title.toLowerCase().replace(/\s+/g, "-")}.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Server-rendered PDF of the same drill list (pdf-lib). Fetched as a blob so the
// session cookie is sent and we control the filename.
async function exportPdf(metric: string, title: string, range: DashboardRange): Promise<void> {
  const url = `/api/dashboard/export?metric=${encodeURIComponent(metric)}&from=${encodeURIComponent(
    range.from
  )}&to=${encodeURIComponent(range.to)}&format=pdf`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return;
  triggerDownload(await res.blob(), `${title.toLowerCase().replace(/\s+/g, "-")}.pdf`);
}

// Generic drill-down list behind a KPI card (spec 5.1). `metric` drives both the
// title and the fetch; null = closed.
export default function DrillDownDialog({
  metric,
  title,
  range,
  onClose,
}: {
  metric: string | null;
  title: string;
  range: DashboardRange;
  onClose: () => void;
}) {
  const { data, isLoading } = useDashboardDrill(metric, range);
  const rows = data?.rows ?? [];

  return (
    <Dialog open={metric !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle>
              {title}
              {!isLoading && <span className="ml-2 text-sm text-muted-foreground">({rows.length})</span>}
            </DialogTitle>
            <div className="flex items-center gap-1.5 print:hidden">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={rows.length === 0}
                onClick={() => exportRowsCsv(title, rows)}
                data-testid="drill-export-csv"
              >
                <Download className="w-3.5 h-3.5" />
                CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={rows.length === 0 || metric === null}
                onClick={() => metric && exportPdf(metric, title, range)}
                data-testid="drill-export-pdf"
              >
                <FileText className="w-3.5 h-3.5" />
                PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => window.print()}
                data-testid="drill-print"
              >
                <Printer className="w-3.5 h-3.5" />
                Print
              </Button>
            </div>
          </div>
        </DialogHeader>

        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Memuat…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Tidak ada data.</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => {
              const badge = LEAD_BADGE[r.leadStatus] ?? LEAD_BADGE.unknown;
              return (
                <Link
                  key={r.chatId}
                  href={`/chats/${r.chatId}`}
                  className="flex items-center gap-3 py-2 hover:bg-accent/40 -mx-2 px-2 rounded"
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground">
                    {(r.contactName || r.phoneNumber || "?").slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.contactName || r.phoneNumber}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.lastMessage ?? "—"}</p>
                  </div>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                    {badge.label}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
