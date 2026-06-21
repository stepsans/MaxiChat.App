import { useQuery } from "@tanstack/react-query";

export interface SystemHealth {
  channels: {
    id: number;
    label: string;
    status: string;
    connected: boolean;
    connectedAt: string | null;
    lastError: string | null;
  }[];
  engines: {
    engine: string;
    label: string;
    health: string;
    isEnabled: boolean;
    priority: number;
    unhealthyUntil: string | null;
  }[];
  jobs: {
    jobName: string;
    status: string;
    finishedAt: string | null;
    errorMessage: string | null;
  }[];
  credit: {
    usagePercent: number;
    tokenRemaining: number;
    projectedDaysRemaining: number | null;
    blocked: boolean;
    notifyLevel: string;
  } | null;
  overall: "ok" | "warning" | "critical";
}

async function fetchHealth(): Promise<SystemHealth> {
  const res = await fetch("/api/dashboard/system-health", { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// System Health strip data (spec A.9). Polls every 30s so a channel drop or job
// failure surfaces quickly without a manual refresh.
export function useSystemHealth(enabled = true) {
  return useQuery<SystemHealth>({
    queryKey: ["/api/dashboard/system-health"],
    queryFn: fetchHealth,
    enabled,
    refetchInterval: 30_000,
  });
}
