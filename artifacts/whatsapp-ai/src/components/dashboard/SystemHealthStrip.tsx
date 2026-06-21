import { useState } from "react";
import { useLocation } from "wouter";
import {
  ChevronDown,
  ChevronUp,
  Wifi,
  WifiOff,
  Cpu,
  Clock,
  Coins,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSystemHealth, type SystemHealth } from "@/hooks/useSystemHealth";

// "System Health" strip (spec A.9) — reliability signals at the top of Tier 1.
// Always visible (thin when all-green), expands to a per-row detail with actions.

const OVERALL_META: Record<SystemHealth["overall"], { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-success", text: "text-success", label: "Semua sehat" },
  warning: { dot: "bg-warning", text: "text-warning", label: "Perlu perhatian" },
  critical: { dot: "bg-destructive", text: "text-destructive", label: "Ada masalah" },
};

const JOB_LABELS: Record<string, string> = {
  ai_pipeline_cutoff: "AI Pipeline cut-off",
  ai_chat_report: "AI Chat Report",
  agent_quality: "Evaluasi agent",
  crm_followup_poller: "Poller follow-up",
};

function statusClasses(kind: "good" | "warn" | "bad" | "idle"): string {
  return {
    good: "bg-success",
    warn: "bg-warning",
    bad: "bg-destructive",
    idle: "bg-muted-foreground/40",
  }[kind];
}

function jobKind(status: string): "good" | "warn" | "bad" | "idle" {
  if (status === "ok") return "good";
  if (status === "failed") return "bad";
  if (status === "running") return "warn";
  return "idle"; // never
}

function engineKind(health: string, enabled: boolean): "good" | "warn" | "bad" | "idle" {
  if (!enabled) return "idle";
  if (health === "healthy") return "good";
  if (health === "unhealthy") return "bad";
  return "warn"; // unknown
}

export default function SystemHealthStrip() {
  const { data, isLoading, isError, refetch } = useSystemHealth();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  if (isLoading || isError || !data) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        {isError ? "Status sistem tidak tersedia." : "Memuat status sistem…"}
      </div>
    );
  }

  const meta = OVERALL_META[data.overall];
  const channelsDown = data.channels.filter((c) => !c.connected).length;
  const jobsFailed = data.jobs.filter((j) => j.status === "failed").length;

  const summary =
    data.overall === "ok"
      ? meta.label
      : [
          channelsDown > 0 ? `${channelsDown} channel terputus` : null,
          jobsFailed > 0 ? `${jobsFailed} job gagal` : null,
          data.credit?.blocked ? "kredit AI habis" : null,
          data.credit && !data.credit.blocked && data.credit.usagePercent >= 90
            ? "kredit AI menipis"
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || meta.label;

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Strip */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
        <span className={cn("text-sm font-medium", meta.text)}>{summary}</span>
        <span className="ml-1 text-xs text-muted-foreground">
          · {data.channels.length} channel · {data.engines.filter((e) => e.isEnabled).length} mesin AI
        </span>
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="grid gap-4 border-t border-border p-3 md:grid-cols-2">
          {/* Channels */}
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Wifi className="h-3.5 w-3.5" /> Koneksi channel
            </h4>
            <div className="space-y-1.5">
              {data.channels.length === 0 && (
                <p className="text-xs text-muted-foreground">Belum ada channel.</p>
              )}
              {data.channels.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-sm">
                  {c.connected ? (
                    <Wifi className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5 text-destructive" />
                  )}
                  <span className="truncate">{c.label}</span>
                  <span
                    className={cn(
                      "text-xs",
                      c.connected ? "text-success" : "text-destructive"
                    )}
                  >
                    {c.connected ? "Tersambung" : "Terputus"}
                  </span>
                  {!c.connected && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto h-6 px-2 text-xs"
                      onClick={() => navigate("/channels")}
                    >
                      Hubungkan ulang
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* AI engines */}
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" /> Mesin AI (failover)
            </h4>
            <div className="space-y-1.5">
              {data.engines.map((e) => (
                <div key={e.engine} className="flex items-center gap-2 text-sm">
                  <span className={cn("h-2 w-2 rounded-full", statusClasses(engineKind(e.health, e.isEnabled)))} />
                  <span className="truncate">{e.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {!e.isEnabled
                      ? "nonaktif"
                      : e.health === "unhealthy"
                      ? "cooldown"
                      : e.health === "healthy"
                      ? "sehat"
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Jobs */}
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> Job terjadwal
            </h4>
            <div className="space-y-1.5">
              {data.jobs.map((j) => (
                <div key={j.jobName} className="flex items-center gap-2 text-sm">
                  <span className={cn("h-2 w-2 rounded-full", statusClasses(jobKind(j.status)))} />
                  <span className="truncate">{JOB_LABELS[j.jobName] ?? j.jobName}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {j.status === "never"
                      ? "belum jalan"
                      : j.finishedAt
                      ? new Date(j.finishedAt).toLocaleString("id-ID", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : j.status}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Credit */}
          {data.credit && (
            <section>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Coins className="h-3.5 w-3.5" /> Kredit AI
              </h4>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>Terpakai</span>
                  <span
                    className={cn(
                      data.credit.blocked
                        ? "text-destructive"
                        : data.credit.usagePercent >= 90
                        ? "text-warning"
                        : "text-foreground"
                    )}
                  >
                    {data.credit.usagePercent}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      data.credit.blocked
                        ? "bg-destructive"
                        : data.credit.usagePercent >= 90
                        ? "bg-warning"
                        : "bg-primary"
                    )}
                    style={{ width: `${Math.min(100, data.credit.usagePercent)}%` }}
                  />
                </div>
                {data.credit.projectedDaysRemaining !== null && (
                  <p className="text-xs text-muted-foreground">
                    Proyeksi habis dalam ~{data.credit.projectedDaysRemaining} hari
                  </p>
                )}
              </div>
            </section>
          )}

          <div className="md:col-span-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => refetch()}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Segarkan
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
