import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { PeriodPicker, type PeriodState } from "@/components/analytics/PeriodPicker";
import { ChannelFilter } from "@/components/analytics/ChannelFilter";
import { SummaryTab } from "@/components/analytics/SummaryTab";
import { AiAnalysisTab } from "@/components/analytics/AiAnalysisTab";
import { ChatHistoryTab } from "@/components/analytics/ChatHistoryTab";
import { ScheduleTab } from "@/components/analytics/ScheduleTab";
import type { PeriodKey } from "@/components/analytics/format";

// ===========================================================================
// Laporan & Jadwal — single analytics surface (spec BAGIAN V). Four tabs:
// Ringkasan · Analisa Percakapan AI · Riwayat Chat · Jadwal Laporan. Tab and
// period live in the URL (?tab=&period=&from=&to=) so deep links + old-route
// redirects land on the right place. Gated by the `analytics` menu.
// ===========================================================================

type TabKey = "summary" | "ai" | "history" | "schedule";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "summary", label: "Ringkasan" },
  { key: "ai", label: "Analisa Percakapan AI" },
  { key: "history", label: "Riwayat Chat" },
  { key: "schedule", label: "Jadwal Laporan" },
];
const TAB_KEYS = new Set<TabKey>(TABS.map((t) => t.key));
const PERIOD_KEYS = new Set<PeriodKey>(["today", "7d", "30d", "custom"]);

export default function ReportsAndSchedules() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { menus, isLoading } = usePermissions();

  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const urlTab = sp.get("tab") as TabKey | null;
  const urlPeriod = sp.get("period") as PeriodKey | null;
  const urlChannel = Number(sp.get("channel"));

  const [tab, setTab] = useState<TabKey>(urlTab && TAB_KEYS.has(urlTab) ? urlTab : "summary");
  const [period, setPeriod] = useState<PeriodState>({
    period: urlPeriod && PERIOD_KEYS.has(urlPeriod) ? urlPeriod : "today",
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  });
  // undefined = "Semua channel" (every channel the viewer can access).
  const [channel, setChannel] = useState<number | undefined>(
    Number.isInteger(urlChannel) && urlChannel > 0 ? urlChannel : undefined,
  );

  // Keep tab in sync when the URL changes externally (e.g. a redirect or a
  // next-action link that points at ?tab=...).
  useEffect(() => {
    if (urlTab && TAB_KEYS.has(urlTab) && urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const syncUrl = (nextTab: TabKey, nextPeriod: PeriodState, nextChannel: number | undefined) => {
    const next = new URLSearchParams();
    next.set("tab", nextTab);
    next.set("period", nextPeriod.period);
    if (nextPeriod.period === "custom") {
      if (nextPeriod.from) next.set("from", nextPeriod.from);
      if (nextPeriod.to) next.set("to", nextPeriod.to);
    }
    if (nextChannel != null) next.set("channel", String(nextChannel));
    navigate(`/analytics?${next.toString()}`, { replace: true });
  };

  const onTabChange = (v: string) => {
    const t = v as TabKey;
    setTab(t);
    syncUrl(t, period, channel);
  };
  const onPeriodChange = (v: PeriodState) => {
    setPeriod(v);
    syncUrl(tab, v, channel);
  };
  const onChannelChange = (v: number | undefined) => {
    setChannel(v);
    syncUrl(tab, period, v);
  };

  // Only the from/to that form a complete custom range get passed downstream.
  const periodArgs =
    period.period === "custom" && period.from && period.to
      ? { period: "custom" as PeriodKey, from: period.from, to: period.to }
      : { period: period.period, from: undefined, to: undefined };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!menus.analytics.canView) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Anda tidak memiliki akses ke menu ini.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">Laporan &amp; Jadwal</h1>
          <p className="text-xs text-muted-foreground">Data diperbarui setiap 15 menit · WIB</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Channel scope applies to the analysis tabs, not the schedule tab. */}
          {tab !== "schedule" && <ChannelFilter value={channel} onChange={onChannelChange} />}
          <PeriodPicker value={period} onChange={onPeriodChange} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-shrink-0 px-6 pt-3">
          <TabsList className="h-9 flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-6">
          <TabsContent value="summary" className="mt-0">
            <SummaryTab period={periodArgs.period} from={periodArgs.from} to={periodArgs.to} channel={channel} />
          </TabsContent>
          <TabsContent value="ai" className="mt-0">
            <AiAnalysisTab period={periodArgs.period} from={periodArgs.from} to={periodArgs.to} channel={channel} />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <ChatHistoryTab period={periodArgs.period} from={periodArgs.from} to={periodArgs.to} channel={channel} />
          </TabsContent>
          <TabsContent value="schedule" className="mt-0">
            <ScheduleTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
