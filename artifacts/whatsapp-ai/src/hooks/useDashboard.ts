import { useQuery } from "@tanstack/react-query";

export interface DashboardRange {
  from: string; // ISO
  to: string; // ISO
}

export interface DashboardSummary {
  role: "owner" | "cs";
  range: { from: string; to: string };
  percakapan: { count: number; previous: number; delta: number };
  belum_dibalas: number;
  avg_frt_seconds: number | null;
  ai_handled_percent: number | null;
  my_active: number;
  lead_panas: number | null;
  tidak_puas: number | null;
  won: { count: number; value: number } | null;
  lead_status: { lead: number; not_lead: number; unknown: number };
}

export interface DrillRow {
  chatId: number;
  contactName: string;
  phoneNumber: string;
  channelId: number;
  status: string;
  leadStatus: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function qs(range: DashboardRange): string {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

// "Today" ranges are live (poll); historical ranges are static report mode.
export function useDashboardSummary(range: DashboardRange, live: boolean) {
  return useQuery<DashboardSummary>({
    queryKey: ["/api/dashboard/summary", range.from, range.to],
    queryFn: () => apiFetch(`/api/dashboard/summary?${qs(range)}`),
    refetchInterval: live ? 30_000 : false,
  });
}

// Drill list behind a card. `metric` null = disabled (dialog closed).
export function useDashboardDrill(metric: string | null, range: DashboardRange) {
  return useQuery<{ metric: string; rows: DrillRow[] }>({
    queryKey: ["/api/dashboard/drill", metric, range.from, range.to],
    queryFn: () => apiFetch(`/api/dashboard/drill/${metric}?${qs(range)}`),
    enabled: metric !== null,
  });
}

export interface ProductRow {
  product: string;
  count: number;
}

// "Produk paling diminati" ranking (spec A.3).
export function useDashboardProducts(range: DashboardRange, enabled: boolean) {
  return useQuery<{ rows: ProductRow[] }>({
    queryKey: ["/api/dashboard/products", range.from, range.to],
    queryFn: () => apiFetch(`/api/dashboard/products?${qs(range)}`),
    enabled,
  });
}

export interface FlowMenuRow {
  label: string;
  level: number;
  count: number;
}

// "Menu chatbot ditekan" ranking (spec A.4). hasActiveFlow drives the
// conditional panel (show an activation hint when there's no flow).
export function useDashboardFlowMenu(range: DashboardRange, enabled: boolean) {
  return useQuery<{ hasActiveFlow: boolean; rows: FlowMenuRow[] }>({
    queryKey: ["/api/dashboard/flow-menu", range.from, range.to],
    queryFn: () => apiFetch(`/api/dashboard/flow-menu?${qs(range)}`),
    enabled,
  });
}

export interface TopQuestion {
  intent: string;
  count: number;
}

// "Pertanyaan tersering" cached snapshot (spec A.3). Recomputed on a schedule;
// computedAt null = not yet generated.
export function useDashboardTopQuestions(enabled: boolean) {
  return useQuery<{ questions: TopQuestion[]; windowDays: number; computedAt: string | null }>({
    queryKey: ["/api/dashboard/top-questions"],
    queryFn: () => apiFetch(`/api/dashboard/top-questions`),
    enabled,
  });
}

export interface Tier2Chat {
  range: { from: string; to: string };
  kpi: {
    percakapan: { count: number; previous: number; delta: number };
    avg_frt_seconds: number | null;
    ai_handled_percent: number | null;
    belum_dibalas: number;
  };
  volume_by_hour: { hour: number; count: number }[];
  ai_vs_human: { ai: number; human: number };
}

// Chat module Tier-2 dashboard (spec A.10).
export function useDashboardTier2Chat(range: DashboardRange, live: boolean) {
  return useQuery<Tier2Chat>({
    queryKey: ["/api/dashboard/tier2/chat", range.from, range.to],
    queryFn: () => apiFetch(`/api/dashboard/tier2/chat?${qs(range)}`),
    refetchInterval: live ? 30_000 : false,
  });
}
