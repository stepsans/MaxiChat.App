import { Fragment, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Trophy,
  ChevronLeft,
  ChevronDown,
  Printer,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";
import { useDashboardTier2AgentKpi, type AgentKpiTableRow } from "@/hooks/useDashboard";

// Agent KPI Tier-2 (spec A.10) — every dimension per agent in one table plus the
// AI coaching narrative (summary/strengths/improvements) per agent. Sourced from
// the latest completed ACR job. Reached from the Dashboard "KPI Agent" tile.

function score(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)}`;
}
function speed(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)} mnt`;
}
function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

const GRADE_TONE: Record<string, string> = {
  A: "bg-success/15 text-success",
  B: "bg-success/15 text-success",
  C: "bg-warning/15 text-warning",
  D: "bg-destructive/15 text-destructive",
  E: "bg-destructive/15 text-destructive",
};

function CoachingDetail({ row }: { row: AgentKpiTableRow }) {
  if (!row.aiSummary && !row.aiStrengths && !row.aiImprovements) {
    return (
      <p className="text-xs text-muted-foreground px-3 py-2">
        Belum ada catatan coaching AI untuk agent ini.
      </p>
    );
  }
  return (
    <div className="space-y-2 px-3 py-2 text-xs">
      {row.aiSummary && <p className="text-foreground leading-relaxed">{row.aiSummary}</p>}
      {row.aiStrengths && (
        <div>
          <p className="font-medium text-success mb-0.5">Kekuatan</p>
          <p className="text-muted-foreground whitespace-pre-line">{row.aiStrengths}</p>
        </div>
      )}
      {row.aiImprovements && (
        <div>
          <p className="font-medium text-warning mb-0.5">Perlu Ditingkatkan</p>
          <p className="text-muted-foreground whitespace-pre-line">{row.aiImprovements}</p>
        </div>
      )}
    </div>
  );
}

const COLS: { key: keyof AgentKpiTableRow; label: string; ai?: boolean }[] = [
  { key: "kpi", label: "KPI" },
  { key: "speed", label: "Kecepatan" },
  { key: "lang", label: "Bahasa", ai: true },
  { key: "accuracy", label: "Ketepatan", ai: true },
  { key: "complaint", label: "Komplain", ai: true },
  { key: "unanswered", label: "Tak Terjawab" },
];

export default function AgentKpiInsights() {
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.dashboard?.canView;
  const [, navigate] = useLocation();
  const { data, isLoading } = useDashboardTier2AgentKpi(!!canView);
  const [expanded, setExpanded] = useState<number | null>(null);

  if (!permLoading && !canView) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-muted-foreground" />
              <CardTitle>Akses ditolak</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Anda tidak memiliki izin untuk melihat dashboard ini.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
            className="gap-1 text-muted-foreground print:hidden"
          >
            <ChevronLeft className="w-4 h-4" />
            Dashboard
          </Button>
          <h1 className="text-base font-semibold text-foreground truncate flex items-center gap-2">
            <Trophy className="w-4 h-4 text-muted-foreground" />
            Dashboard KPI Agent
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 print:hidden"
          onClick={() => window.print()}
        >
          <Printer className="w-3.5 h-3.5" />
          Print
        </Button>
      </div>

      <div className="flex-1 p-6 space-y-4">
        <Badge variant="outline" className="text-[10px] gap-1">
          <Sparkles className="w-3 h-3" />
          Bahasa · Ketepatan · Komplain dinilai AI
        </Badge>

        {isLoading ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : !data?.jobId ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Belum ada data KPI agent. Jalankan AI Chat Report terlebih dahulu untuk menilai agent.
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Belum ada agent yang dinilai pada periode terakhir.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left font-medium px-4 py-2.5">Agent</th>
                    <th className="text-center font-medium px-2 py-2.5">Grade</th>
                    {COLS.map((c) => (
                      <th key={c.key} className="text-right font-medium px-3 py-2.5 whitespace-nowrap">
                        {c.label}
                        {c.ai && <Sparkles className="inline w-2.5 h-2.5 ml-0.5 opacity-60" />}
                      </th>
                    ))}
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isOpen = expanded === r.agentUserId;
                    return (
                      <Fragment key={r.agentUserId}>
                        <tr
                          onClick={() => setExpanded(isOpen ? null : r.agentUserId)}
                          className="border-b border-border/60 cursor-pointer hover:bg-accent/40"
                          data-testid={`agent-kpi-row-${r.agentUserId}`}
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <span className="w-4 text-xs font-semibold tabular-nums text-muted-foreground">
                                {i + 1}
                              </span>
                              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                                {initials(r.name)}
                              </span>
                              <div className="min-w-0">
                                <p className="font-medium text-foreground truncate">{r.name}</p>
                                <p className="text-[10px] text-muted-foreground">
                                  {r.totalConversations} percakapan
                                  {r.insufficientData ? " · data minim" : ""}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-center">
                            <span
                              className={cn(
                                "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                                GRADE_TONE[r.grade] ?? "bg-muted text-muted-foreground"
                              )}
                            >
                              {r.grade}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{score(r.kpi)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{speed(r.speed)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{score(r.lang)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{score(r.accuracy)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{score(r.complaint)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.unanswered}</td>
                          <td className="px-2 py-2.5 text-muted-foreground">
                            <ChevronDown className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-border/60 bg-muted/30">
                            <td colSpan={COLS.length + 3}>
                              <CoachingDetail row={r} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
