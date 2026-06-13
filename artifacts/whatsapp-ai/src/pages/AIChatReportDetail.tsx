import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAcrJobResults,
  getGetAcrJobResultsQueryKey,
  useGetAcrJobProgress,
  getGetAcrJobProgressQueryKey,
  useGetAcrAgentDetail,
  getGetAcrAgentDetailQueryKey,
  useListAcrRedFlags,
  getListAcrRedFlagsQueryKey,
  useListAcrConversations,
  getListAcrConversationsQueryKey,
  useGetAcrLeaderboard,
  getGetAcrLeaderboardQueryKey,
  useCreateAcrJob,
  getListAcrJobsQueryKey,
  useMarkAcrNotificationRead,
  useListAcrAchievements,
  getListAcrAchievementsQueryKey,
  type AcrAgentScore,
  type AcrRedFlag,
  type AcrConversationScore,
  type ListAcrRedFlagsParams,
  type ListAcrConversationsParams,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { downloadAcrExport, VIOLATION_LABELS } from "./AIChatReport";

// ─── shared helpers ─────────────────────────────────────────────────────────

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const fmtDate = (d: string): string =>
  new Date(`${d}T00:00:00+07:00`).toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const fmtDateTime = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

const GRADE_COLORS: Record<string, string> = {
  A: "bg-emerald-600",
  B: "bg-sky-600",
  C: "bg-amber-500",
  D: "bg-orange-600",
  E: "bg-red-600",
};

function GradePill({ grade }: { grade: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white",
        GRADE_COLORS[grade] ?? "bg-slate-500"
      )}
    >
      {grade}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const v =
    severity === "critical"
      ? "bg-red-600"
      : severity === "high"
        ? "bg-orange-500"
        : "bg-amber-400";
  return <Badge className={cn(v, "hover:" + v, "capitalize text-white")}>{severity}</Badge>;
}

const VIOLATION_BADGE: Record<string, string> = {
  customer_angry: "bg-red-600",
  rude_language: "bg-red-900",
  no_reply_critical: "bg-slate-700",
  customer_ignored: "bg-orange-500",
  answer_caused_dropout: "bg-purple-600",
};

function ViolationBadge({ type }: { type: string }) {
  return (
    <Badge className={cn(VIOLATION_BADGE[type] ?? "bg-slate-500", "text-white")}>
      {VIOLATION_LABELS[type] ?? type}
    </Badge>
  );
}

function DeltaBadge({ delta }: { delta: number | null | undefined }) {
  if (delta == null) return <span className="text-muted-foreground">──</span>;
  if (Math.abs(delta) < 2) return <span className="text-muted-foreground">──</span>;
  return delta > 0 ? (
    <span className="inline-flex items-center gap-0.5 text-emerald-600">
      <TrendingUp className="h-3 w-3" /> +{delta.toFixed(1)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-red-600">
      <TrendingDown className="h-3 w-3" /> {delta.toFixed(1)}
    </span>
  );
}

function BreakdownBar({
  label,
  value,
  max,
  extra,
}: {
  label: string;
  value: number;
  max: number;
  extra?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right font-medium">
        {value.toFixed(1)} / {max}
      </span>
      {extra && <span className="w-20 shrink-0 text-xs text-muted-foreground">{extra}</span>}
    </div>
  );
}

// ─── Agent detail drawer ────────────────────────────────────────────────────

function AgentDetailDrawer({
  jobId,
  agentId,
  weights,
  onClose,
  onShowConversations,
  onShowRedFlags,
}: {
  jobId: string;
  agentId: number | null;
  weights: Record<string, number>;
  onClose: () => void;
  onShowConversations: (agentId: number) => void;
  onShowRedFlags: (agentId: number) => void;
}) {
  const { data, isLoading } = useGetAcrAgentDetail(jobId, agentId ?? 0, {
    query: {
      queryKey: getGetAcrAgentDetailQueryKey(jobId, agentId ?? 0),
      enabled: agentId != null,
    },
  });
  const s = data?.score;
  const ci = data?.coachingInsights;
  const { data: achievements } = useListAcrAchievements(
    { agentId: agentId ?? 0 },
    {
      query: {
        queryKey: getListAcrAchievementsQueryKey({ agentId: agentId ?? 0 }),
        enabled: agentId != null,
      },
    }
  );

  return (
    <Sheet open={agentId != null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {isLoading || !s ? (
          <div className="space-y-3 pt-8">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center justify-between pr-6">
                <span>{s.agentName ?? s.agentEmail}</span>
                <GradePill grade={s.grade} />
              </SheetTitle>
              <SheetDescription>
                {s.agentRole} · ID: {s.agentUserId}
                {s.insufficientData && (
                  <Badge variant="outline" className="ml-2 border-amber-500 text-amber-600">
                    Data kurang dari 5 percakapan
                  </Badge>
                )}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 py-4">
              <div className="text-center">
                <p className="text-4xl font-bold">
                  {s.totalScore.toFixed(1)} <span className="text-lg font-normal">/ 100</span>
                </p>
                <Progress value={s.totalScore} className="mx-auto mt-2 h-2 w-2/3" />
                <p className="mt-1 text-sm">
                  <DeltaBadge delta={data?.deltaVsPrevious} />
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-semibold">Breakdown</p>
                <BreakdownBar
                  label="Kecepatan Balas"
                  value={s.scoreResponseTime ?? 0}
                  max={weights.weightResponseTime ?? 25}
                  extra={
                    s.avgResponseTimeMinutes != null
                      ? `${Math.round(s.avgResponseTimeMinutes)} mnt`
                      : undefined
                  }
                />
                <BreakdownBar
                  label="Kualitas Bahasa"
                  value={s.scoreLanguageQuality ?? 0}
                  max={weights.weightLanguageQuality ?? 25}
                />
                <BreakdownBar
                  label="Ketepatan Jawaban"
                  value={s.scoreAnswerQuality ?? 0}
                  max={weights.weightAnswerQuality ?? 25}
                />
                <BreakdownBar
                  label="Handling Komplain"
                  value={s.scoreComplaintHandling ?? 0}
                  max={weights.weightComplaintHandling ?? 15}
                />
                <BreakdownBar
                  label="Chat Tak Terjawab"
                  value={s.scoreMissedChat ?? 0}
                  max={weights.weightMissedChat ?? 10}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
                <p className="text-muted-foreground">Total percakapan</p>
                <p className="text-right font-medium">{s.totalConversations}</p>
                <p className="text-muted-foreground">Total pesan dikirim</p>
                <p className="text-right font-medium">{s.totalMessagesSent}</p>
                <p className="text-muted-foreground">Rata-rata waktu balas</p>
                <p className="text-right font-medium">
                  {s.avgResponseTimeMinutes != null
                    ? `${Math.round(s.avgResponseTimeMinutes)} menit`
                    : "-"}
                </p>
                <p className="text-muted-foreground">Chat tidak terjawab</p>
                <p className="text-right font-medium">{s.totalMissedChats}</p>
                <p className="text-muted-foreground">Percakapan komplain</p>
                <p className="text-right font-medium">
                  {s.totalComplaints}
                  {(s.totalComplaints ?? 0) > 0
                    ? ` (${Math.round(
                        ((s.complaintsResolved ?? 0) / (s.totalComplaints || 1)) * 100
                      )}% selesai)`
                    : ""}
                </p>
                <p className="text-muted-foreground">Red flag</p>
                <p className="text-right font-medium">{s.redFlagCount}</p>
              </div>

              {(data?.trend?.length ?? 0) > 1 && (
                <div>
                  <p className="mb-1 text-sm font-semibold">Perkembangan (6 periode terakhir)</p>
                  <div className="h-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data!.trend}>
                        <XAxis dataKey="periodStart" hide />
                        <YAxis domain={[0, 100]} hide />
                        <ChartTooltip
                          formatter={(v: number) => [v.toFixed(1), "Skor"]}
                          labelFormatter={(l: string) => fmtDate(l)}
                        />
                        <Line
                          type="monotone"
                          dataKey="totalScore"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="rounded-md border p-3 text-sm">
                <p className="text-muted-foreground">Tunjangan</p>
                <p className="text-lg font-semibold">
                  Grade {s.grade} → {IDR.format(s.allowanceAmount ?? 0)}
                </p>
              </div>

              {s.aiSummary && (
                <div>
                  <p className="text-sm font-semibold">AI Summary</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                    {s.aiSummary}
                  </p>
                </div>
              )}
              {s.aiStrengths && (
                <div>
                  <p className="text-sm font-semibold">AI Kelebihan</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                    {s.aiStrengths}
                  </p>
                </div>
              )}
              {s.aiImprovements && (
                <div>
                  <p className="text-sm font-semibold">AI Area Perbaikan</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                    {s.aiImprovements}
                  </p>
                </div>
              )}

              {ci && (
                <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                  <p className="text-sm font-semibold">Coaching AI</p>
                  {(ci.topImprovements?.length ?? 0) > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        3 Hal Utama yang Perlu Diperbaiki
                      </p>
                      <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm">
                        {ci.topImprovements!.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {ci.bestConversationExcerpt && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Percakapan Terbaik
                      </p>
                      <blockquote className="mt-1 border-l-2 pl-2 text-sm italic">
                        {ci.bestConversationExcerpt}
                      </blockquote>
                    </div>
                  )}
                  {ci.worstConversationExcerpt && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Percakapan yang Perlu Diperbaiki
                      </p>
                      <blockquote className="mt-1 border-l-2 border-red-400 pl-2 text-sm italic">
                        {ci.worstConversationExcerpt}
                      </blockquote>
                      {ci.worstConversationAnnotation && (
                        <p className="mt-1 text-sm text-red-600">
                          {ci.worstConversationAnnotation}
                        </p>
                      )}
                    </div>
                  )}
                  {ci.teamComparison && (
                    <div className="text-sm">
                      <p className="text-xs font-medium text-muted-foreground">Perbandingan Tim</p>
                      <p>
                        Waktu balas: {s.avgResponseTimeMinutes != null ? Math.round(s.avgResponseTimeMinutes) : "-"} mnt ·
                        Rata-rata tim: {Math.round(ci.teamComparison.avgResponseTimeTeam ?? 0)} mnt
                      </p>
                      <p>
                        Skor: {s.totalScore.toFixed(1)} · Rata-rata tim:{" "}
                        {(ci.teamComparison.avgScoreTeam ?? 0).toFixed(1)}
                      </p>
                      <p>
                        Ranking: #{ci.teamComparison.agentRank} dari{" "}
                        {ci.teamComparison.totalAgents} agent
                      </p>
                    </div>
                  )}
                </div>
              )}

              {(data?.redFlags?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-semibold text-red-600">
                    Red Flag ({data!.redFlags.length})
                  </p>
                  <div className="mt-1 space-y-1">
                    {data!.redFlags.slice(0, 5).map((f) => (
                      <div key={f.id} className="flex items-center gap-2 text-sm">
                        <ViolationBadge type={f.violationType} />
                        <span className="text-muted-foreground">
                          {f.contactName ?? "-"} · {fmtDateTime(f.occurredAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(achievements?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-semibold">Pencapaian</p>
                  <div className="mt-1 space-y-1">
                    {achievements!.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-sm">
                        <span className="text-lg">{a.achievementIcon}</span>
                        <span>{a.achievementName}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {a.earnedAtPeriod}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onShowConversations(s.agentUserId)}>
                  Lihat Percakapan
                </Button>
                <Button variant="outline" onClick={() => onShowRedFlags(s.agentUserId)}>
                  Lihat Red Flag
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Red flag drawer ────────────────────────────────────────────────────────

function RedFlagDrawer({ flag, onClose }: { flag: AcrRedFlag | null; onClose: () => void }) {
  return (
    <Sheet open={flag != null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {flag && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <ViolationBadge type={flag.violationType} />
                <SeverityBadge severity={flag.violationSeverity} />
              </SheetTitle>
              <SheetDescription>
                Agent: {flag.agentName ?? "-"} · Customer: {flag.contactName ?? "-"} · Channel:{" "}
                {flag.channelType ?? "-"}
                <br />
                Waktu: {fmtDateTime(flag.occurredAt)}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 py-4">
              {flag.conversationExcerpt && (
                <div>
                  <p className="text-sm font-semibold">Percakapan (excerpt)</p>
                  <pre className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                    {flag.conversationExcerpt}
                  </pre>
                </div>
              )}
              <div>
                <p className="text-sm font-semibold">Penjelasan AI</p>
                <p className="mt-1 text-sm text-muted-foreground">{flag.aiExplanation}</p>
              </div>
              {flag.aiRecommendation && (
                <div>
                  <p className="text-sm font-semibold">Rekomendasi AI</p>
                  <p className="mt-1 text-sm text-muted-foreground">{flag.aiRecommendation}</p>
                </div>
              )}
              {flag.scoreImpactDimension && (
                <div>
                  <p className="text-sm font-semibold">Dampak ke Skor</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Dimensi{" "}
                    {
                      (
                        {
                          response_time: "Kecepatan Balas",
                          language_quality: "Kualitas Bahasa",
                          answer_quality: "Ketepatan Jawaban",
                          complaint_handling: "Handling Komplain",
                          missed_chat: "Chat Tak Terjawab",
                        } as Record<string, string>
                      )[flag.scoreImpactDimension] ?? flag.scoreImpactDimension
                    }
                    : -{(flag.scoreImpactPoints ?? 0).toFixed(1)} poin
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Conversation drawer ────────────────────────────────────────────────────

function ConversationDrawer({
  conv,
  onClose,
  onShowRedFlags,
}: {
  conv: AcrConversationScore | null;
  onClose: () => void;
  onShowRedFlags: (agentId: number) => void;
}) {
  return (
    <Sheet open={conv != null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {conv && (
          <>
            <SheetHeader>
              <SheetTitle>{conv.contactName ?? "Percakapan"}</SheetTitle>
              <SheetDescription>
                {conv.channelType ?? "-"} · {fmtDateTime(conv.firstMessageAt)} –{" "}
                {fmtDateTime(conv.lastMessageAt)}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 py-4">
              <div className="text-center">
                <p className="text-3xl font-bold">
                  {(conv.convTotalScore ?? 0).toFixed(0)}
                  <span className="text-base font-normal"> / 100</span>
                </p>
              </div>
              <div className="space-y-2">
                <BreakdownBar label="Kecepatan Balas" value={conv.convScoreResponseTime ?? 0} max={100} />
                <BreakdownBar label="Kualitas Bahasa" value={conv.convScoreLanguageQuality ?? 0} max={100} />
                <BreakdownBar label="Ketepatan Jawaban" value={conv.convScoreAnswerQuality ?? 0} max={100} />
                <BreakdownBar label="Handling Komplain" value={conv.convScoreComplaintHandling ?? 0} max={100} />
                <BreakdownBar label="Chat Terjawab" value={conv.convScoreMissedChat ?? 0} max={100} />
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
                <p className="text-muted-foreground">Total pesan</p>
                <p className="text-right font-medium">{conv.totalMessages}</p>
                <p className="text-muted-foreground">Pesan agent / customer</p>
                <p className="text-right font-medium">
                  {conv.agentMessages} / {conv.customerMessages}
                </p>
                <p className="text-muted-foreground">Avg / max waktu balas</p>
                <p className="text-right font-medium">
                  {conv.avgResponseTimeMinutes != null
                    ? `${Math.round(conv.avgResponseTimeMinutes)} mnt`
                    : "-"}{" "}
                  /{" "}
                  {conv.maxResponseTimeMinutes != null
                    ? `${Math.round(conv.maxResponseTimeMinutes)} mnt`
                    : "-"}
                </p>
                <p className="text-muted-foreground">Komplain</p>
                <p className="text-right font-medium">
                  {conv.hasComplaint
                    ? conv.complaintResolved
                      ? "Ada — selesai"
                      : "Ada — belum selesai"
                    : "Tidak ada"}
                </p>
              </div>
              {(conv.redFlagTypes?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-semibold text-red-600">Red Flag</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {conv.redFlagTypes!.map((t) => (
                      <ViolationBadge key={t} type={t} />
                    ))}
                  </div>
                  {conv.agentUserId != null && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => onShowRedFlags(conv.agentUserId!)}
                    >
                      Lihat detail red flag
                    </Button>
                  )}
                </div>
              )}
              {conv.aiNotes && (
                <div>
                  <p className="text-sm font-semibold">Catatan AI</p>
                  <p className="mt-1 text-sm text-muted-foreground">{conv.aiNotes}</p>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AIChatReportDetail() {
  const [, params] = useRoute("/ai-chat-report/:jobId");
  const jobId = params?.jobId ?? "";
  const [, navigate] = useLocation();
  const { menus, isAgent, isLoading: permsLoading } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();

  const search = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState(search.get("tab") ?? "ringkasan");
  const [drawerAgent, setDrawerAgent] = useState<number | null>(null);
  const [drawerFlag, setDrawerFlag] = useState<AcrRedFlag | null>(null);
  const [drawerConv, setDrawerConv] = useState<AcrConversationScore | null>(null);

  useEffect(() => {
    if (!permsLoading && !menus.acr.canView) navigate("/");
  }, [permsLoading, menus.acr.canView, navigate]);

  // Mark the notification read when arriving via the bell deep-link.
  const markRead = useMarkAcrNotificationRead();
  useEffect(() => {
    const notifId = search.get("notif");
    if (notifId) markRead.mutate({ notifId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: progress } = useGetAcrJobProgress(jobId, {
    query: {
      queryKey: getGetAcrJobProgressQueryKey(jobId),
      refetchInterval: (q) =>
        q.state.data?.status === "running" || q.state.data?.status === "pending" ? 3000 : false,
    },
  });
  const running = progress?.status === "running" || progress?.status === "pending";

  const { data: results, isLoading } = useGetAcrJobResults(jobId, {
    query: {
      queryKey: getGetAcrJobResultsQueryKey(jobId),
      refetchInterval: running ? 5000 : false,
    },
  });
  const job = results?.job;
  // KPI weights come from the job's immutable config snapshot via the API.
  const w = {
    weightResponseTime: results?.weights.weightResponseTime ?? 25,
    weightLanguageQuality: results?.weights.weightLanguageQuality ?? 25,
    weightAnswerQuality: results?.weights.weightAnswerQuality ?? 25,
    weightComplaintHandling: results?.weights.weightComplaintHandling ?? 15,
    weightMissedChat: results?.weights.weightMissedChat ?? 10,
  };

  const createJob = useCreateAcrJob();
  const completed = job?.status === "completed";

  // Per-agent tab state.
  const [agentSearch, setAgentSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [gradeFilter, setGradeFilter] = useState("all");
  const [agentSort, setAgentSort] = useState("score_desc");

  const filteredAgents = useMemo(() => {
    let list = [...(results?.agents ?? [])];
    if (roleFilter !== "all") list = list.filter((a) => a.agentRole === roleFilter);
    if (gradeFilter !== "all") list = list.filter((a) => a.grade === gradeFilter);
    if (agentSearch.trim()) {
      const q = agentSearch.trim().toLowerCase();
      list = list.filter(
        (a) =>
          (a.agentName ?? "").toLowerCase().includes(q) ||
          (a.agentEmail ?? "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => {
      if (agentSort === "score_asc") return a.totalScore - b.totalScore;
      if (agentSort === "redflags") return (b.redFlagCount ?? 0) - (a.redFlagCount ?? 0);
      if (agentSort === "name")
        return (a.agentName ?? "").localeCompare(b.agentName ?? "");
      return b.totalScore - a.totalScore;
    });
    return list;
  }, [results, roleFilter, gradeFilter, agentSearch, agentSort]);

  // Red flag tab state.
  const [rfType, setRfType] = useState("all");
  const [rfSeverity, setRfSeverity] = useState("all");
  const [rfAgent, setRfAgent] = useState("all");
  const [rfSort, setRfSort] = useState<"latest" | "severity" | "agent">("latest");
  const [rfPage, setRfPage] = useState(1);
  const rfParams: ListAcrRedFlagsParams = {
    page: rfPage,
    limit: 20,
    ...(rfType !== "all" ? { violationType: rfType } : {}),
    ...(rfSeverity !== "all" ? { severity: rfSeverity } : {}),
    ...(rfAgent !== "all" ? { agentId: Number(rfAgent) } : {}),
    ...(rfSort !== "latest" ? { sort: rfSort } : {}),
  };
  const { data: redFlags } = useListAcrRedFlags(jobId, rfParams, {
    query: {
      queryKey: getListAcrRedFlagsQueryKey(jobId, rfParams),
      enabled: tab === "redflags" && !!jobId,
    },
  });

  // Open the deep-linked red flag drawer once data is in.
  useEffect(() => {
    const flagId = search.get("flag");
    if (flagId && tab === "redflags" && redFlags) {
      const f = redFlags.redFlags.find((x) => x.id === flagId);
      if (f) setDrawerFlag(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redFlags]);

  // Conversations tab state.
  const [convAgent, setConvAgent] = useState<string>("");
  const [convRedFlagOnly, setConvRedFlagOnly] = useState(false);
  const [convComplaintOnly, setConvComplaintOnly] = useState(false);
  const [convSort, setConvSort] = useState<"latest" | "score_asc" | "response_desc">("latest");
  const [convPage, setConvPage] = useState(1);
  const firstAgentId = results?.agents?.[0]?.agentUserId;
  const convAgentId = convAgent ? Number(convAgent) : firstAgentId ?? 0;
  const convParams: ListAcrConversationsParams = {
    page: convPage,
    limit: 20,
    sort: convSort,
    ...(convRedFlagOnly ? { hasRedFlag: true } : {}),
    ...(convComplaintOnly ? { hasComplaint: true } : {}),
  };
  const { data: conversations } = useListAcrConversations(jobId, convAgentId, convParams, {
    query: {
      queryKey: getListAcrConversationsQueryKey(jobId, convAgentId, convParams),
      enabled: tab === "percakapan" && !!jobId && convAgentId > 0,
    },
  });

  const { data: leaderboard } = useGetAcrLeaderboard(jobId, {
    query: {
      queryKey: getGetAcrLeaderboardQueryKey(jobId),
      enabled: tab === "leaderboard" && !!jobId,
    },
  });
  const [lbRole, setLbRole] = useState("all");
  const lbEntries = useMemo(
    () =>
      (leaderboard?.entries ?? []).filter(
        (e) => lbRole === "all" || e.agentRole === lbRole
      ),
    [leaderboard, lbRole]
  );

  const onDownload = async (kind: "csv" | "pdf") => {
    if (!job) return;
    try {
      await downloadAcrExport(job.id, kind, `acr-${job.periodStart}_${job.periodEnd}.${kind}`);
    } catch (err) {
      toast({
        title: "Unduhan gagal",
        description: err instanceof Error ? err.message : "Terjadi kesalahan.",
        variant: "destructive",
      });
    }
  };

  const copyRanking = () => {
    if (!leaderboard || !job) return;
    const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "  ");
    const deltaTxt = (d: number | null | undefined) =>
      d == null ? "──" : Math.abs(d) < 2 ? "──" : d > 0 ? `▲+${d.toFixed(1)}` : `▼${d.toFixed(1)}`;
    const lines = leaderboard.entries.map(
      (e) =>
        `${medal(e.rank)} ${e.rank}. ${e.agentName ?? "(tersembunyi)"} — ${e.totalScore.toFixed(
          1
        )} (Grade ${e.grade}) ${deltaTxt(e.delta)}`
    );
    const txt = `🏆 Ranking Kinerja CS — ${fmtDate(job.periodStart)} – ${fmtDate(
      job.periodEnd
    )}\n\n${lines.join("\n")}\n\nTotal ${leaderboard.entries.length} agent dinilai.`;
    void navigator.clipboard.writeText(txt).then(() =>
      toast({ title: "Ranking disalin ke clipboard." })
    );
  };

  if (isLoading || !results || !job) {
    return (
      <div className="space-y-3 p-6">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const dim = results.dimensionAverages;
  const dimChart = [
    { name: "Kecepatan Balas", value: dim.responseTime, max: w.weightResponseTime },
    { name: "Kualitas Bahasa", value: dim.languageQuality, max: w.weightLanguageQuality },
    { name: "Ketepatan", value: dim.answerQuality, max: w.weightAnswerQuality },
    { name: "Komplain", value: dim.complaintHandling, max: w.weightComplaintHandling },
    { name: "Terjawab", value: dim.missedChat, max: w.weightMissedChat },
  ].map((d) => ({ ...d, pct: d.max > 0 ? Math.round((d.value / d.max) * 100) : 0 }));

  const top3 = lbEntries.slice(0, 3);

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate("/ai-chat-report")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">
              {fmtDate(job.periodStart)} – {fmtDate(job.periodEnd)}
            </h1>
            <div className="mt-0.5 flex items-center gap-2">
              {job.status === "completed" ? (
                <Badge className="bg-emerald-600 hover:bg-emerald-600">Selesai</Badge>
              ) : job.status === "failed" ? (
                <Badge variant="destructive">Gagal</Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Memproses
                </Badge>
              )}
              {running && progress && (progress.progressTotal ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  {progress.progressCompleted} / {progress.progressTotal} percakapan (
                  {progress.pct}%)
                </span>
              )}
              {job.errorMessage && (
                <span className="text-xs text-red-500">{job.errorMessage}</span>
              )}
            </div>
          </div>
        </div>
        {!isAgent && (
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={!completed} onClick={() => void onDownload("csv")}>
              <Download className="mr-2 h-4 w-4" /> Unduh CSV
            </Button>
            <Button variant="outline" disabled={!completed} onClick={() => void onDownload("pdf")}>
              <FileText className="mr-2 h-4 w-4" /> Unduh PDF
            </Button>
            {menus.acr.canCreate && (
              <Button
                variant="outline"
                disabled={createJob.isPending || running}
                onClick={() =>
                  createJob.mutate(
                    {
                      data: {
                        periodStart: job.periodStart,
                        periodEnd: job.periodEnd,
                      },
                    },
                    {
                      onSuccess: (created) => {
                        toast({ title: "Penilaian ulang sedang diproses..." });
                        qc.invalidateQueries({ queryKey: getListAcrJobsQueryKey() });
                        navigate(`/ai-chat-report/${created.id}`);
                      },
                    }
                  )
                }
              >
                <RefreshCw className="mr-2 h-4 w-4" /> Buat Ulang
              </Button>
            )}
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="ringkasan">Ringkasan</TabsTrigger>
          {!isAgent && <TabsTrigger value="agents">Per Agent</TabsTrigger>}
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          {!isAgent && <TabsTrigger value="redflags">Red Flag</TabsTrigger>}
          {!isAgent && <TabsTrigger value="percakapan">Percakapan</TabsTrigger>}
        </TabsList>

        {/* ── TAB 1: Ringkasan ── */}
        <TabsContent value="ringkasan" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Rata-rata skor tim</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {results.summary.avgScore.toFixed(1)} <span className="text-sm font-normal">/ 100</span>
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Agent nilai terbaik</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="truncate text-2xl font-bold">
                  {results.summary.bestAgentName ?? "-"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {results.summary.bestAgentScore?.toFixed(1) ?? "-"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Perlu perhatian</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{results.summary.needsAttentionCount}</p>
                <p className="text-sm text-muted-foreground">agent skor rendah</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Total red flag</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-red-600">{results.summary.totalRedFlags}</p>
                <p className="text-sm text-muted-foreground">pelanggaran berat</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Distribusi Grade</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {(["a", "b", "c", "d", "e"] as const).map((g) => {
                  const n = results.gradeDistribution[g];
                  const total = results.agents.length || 1;
                  return (
                    <div key={g} className="flex items-center gap-2 text-sm">
                      <span className="w-16">Grade {g.toUpperCase()}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                        <div
                          className={cn("h-full", GRADE_COLORS[g.toUpperCase()])}
                          style={{ width: `${(n / total) * 100}%` }}
                        />
                      </div>
                      <span className="w-16 text-right text-muted-foreground">{n} agent</span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Skor Rata-rata Per Dimensi (%)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dimChart}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                      <ChartTooltip formatter={(v: number) => [`${v}%`, "Capaian"]} />
                      <Bar dataKey="pct" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {(results.teamTrend.length ?? 0) >= 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tren Tim</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={results.teamTrend}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="periodStart"
                        tickFormatter={(v: string) => fmtDate(v)}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                      <ChartTooltip
                        formatter={(v: number) => [v.toFixed(1), "Skor rata-rata"]}
                        labelFormatter={(l: string) => fmtDate(l)}
                      />
                      <Area
                        type="monotone"
                        dataKey="avgScore"
                        stroke="hsl(var(--primary))"
                        fill="hsl(var(--primary))"
                        fillOpacity={0.15}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {isAgent && (
            <Card>
              <CardContent className="pt-6">
                <Button onClick={() => setDrawerAgent(results.agents[0]?.agentUserId ?? null)}>
                  <Eye className="mr-2 h-4 w-4" /> Lihat Nilai Saya
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── TAB 2: Per Agent ── */}
        <TabsContent value="agents" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Role</SelectItem>
                <SelectItem value="supervisor">Supervisor</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            <Select value={gradeFilter} onValueChange={setGradeFilter}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Grade" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Grade</SelectItem>
                {["A", "B", "C", "D", "E"].map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cari nama..."
                className="w-48 pl-8"
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
              />
            </div>
            <Select value={agentSort} onValueChange={setAgentSort}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Urutkan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score_desc">Skor Tertinggi</SelectItem>
                <SelectItem value="score_asc">Skor Terendah</SelectItem>
                <SelectItem value="redflags">Red Flag Terbanyak</SelectItem>
                <SelectItem value="name">Nama</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Total Skor</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Kec. Balas</TableHead>
                  <TableHead className="text-right">Bahasa</TableHead>
                  <TableHead className="text-right">Ketepatan</TableHead>
                  <TableHead className="text-right">Handling</TableHead>
                  <TableHead className="text-right">Missed</TableHead>
                  <TableHead className="text-right">Red Flag</TableHead>
                  <TableHead className="text-right">Tunjangan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAgents.map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() => setDrawerAgent(a.agentUserId)}
                    data-testid={`acr-agent-${a.agentUserId}`}
                  >
                    <TableCell>
                      <p className="font-medium">{a.agentName ?? a.agentEmail}</p>
                      <p className="text-xs text-muted-foreground">{a.agentRole}</p>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {a.totalScore.toFixed(1)}
                    </TableCell>
                    <TableCell>
                      <GradePill grade={a.grade} />
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {(a.scoreResponseTime ?? 0).toFixed(1)}/{w.weightResponseTime}
                      {a.avgResponseTimeMinutes != null && (
                        <span className="block text-xs text-muted-foreground">
                          {Math.round(a.avgResponseTimeMinutes)} mnt
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {(a.scoreLanguageQuality ?? 0).toFixed(1)}/{w.weightLanguageQuality}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {(a.scoreAnswerQuality ?? 0).toFixed(1)}/{w.weightAnswerQuality}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {(a.scoreComplaintHandling ?? 0).toFixed(1)}/{w.weightComplaintHandling}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {(a.scoreMissedChat ?? 0).toFixed(1)}/{w.weightMissedChat}
                    </TableCell>
                    <TableCell className="text-right">
                      {(a.redFlagCount ?? 0) > 0 ? (
                        <span className="font-semibold text-red-600">{a.redFlagCount} 🔴</span>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {IDR.format(a.allowanceAmount ?? 0)}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredAgents.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                      Tidak ada agent yang cocok dengan filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── TAB 3: Leaderboard ── */}
        <TabsContent value="leaderboard" className="space-y-4">
          {top3.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-3">
              {top3.map((e) => (
                <Card key={e.rank} className={cn(e.rank === 1 && "border-amber-400")}>
                  <CardContent className="pt-6 text-center">
                    <p className="text-3xl">{e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : "🥉"}</p>
                    <p className="mt-1 font-semibold">{e.agentName ?? "(tersembunyi)"}</p>
                    <p className="text-2xl font-bold">{e.totalScore.toFixed(1)}</p>
                    <GradePill grade={e.grade} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <Select value={lbRole} onValueChange={setLbRole}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Role</SelectItem>
                <SelectItem value="supervisor">Supervisor</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
            {!isAgent && (
              <Button variant="outline" onClick={copyRanking}>
                <Copy className="mr-2 h-4 w-4" /> Salin Ranking
              </Button>
            )}
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Rank</TableHead>
                  <TableHead className="w-20">Delta</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Skor</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Tunjangan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lbEntries.map((e) => (
                  <TableRow
                    key={`${e.rank}`}
                    className={cn(e.isSelf && "bg-primary/5 font-medium")}
                  >
                    <TableCell>{e.rank}</TableCell>
                    <TableCell>
                      <DeltaBadge delta={e.delta} />
                    </TableCell>
                    <TableCell>
                      {e.agentName ?? <span className="text-muted-foreground">█████</span>}
                      {e.isSelf && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          Anda
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{e.totalScore.toFixed(1)}</TableCell>
                    <TableCell>
                      <GradePill grade={e.grade} />
                    </TableCell>
                    <TableCell className="text-right">
                      {e.agentName ? IDR.format(e.allowanceAmount ?? 0) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── TAB 4: Red Flag ── */}
        <TabsContent value="redflags" className="space-y-3">
          <div className="rounded-md border-l-4 border-red-500 bg-red-50 p-3 text-sm dark:bg-red-950/20">
            Berikut pelanggaran berat yang terdeteksi AI. Red flag berdampak langsung pada skor
            dimensi terkait dan membutuhkan tindak lanjut supervisor.
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={rfType} onValueChange={(v) => { setRfType(v); setRfPage(1); }}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Jenis" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Jenis</SelectItem>
                {Object.entries(VIOLATION_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={rfSeverity} onValueChange={(v) => { setRfSeverity(v); setRfPage(1); }}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Severity</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
              </SelectContent>
            </Select>
            <Select value={rfAgent} onValueChange={(v) => { setRfAgent(v); setRfPage(1); }}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Semua Agent</SelectItem>
                {(results.agents ?? []).map((a) => (
                  <SelectItem key={a.agentUserId} value={String(a.agentUserId)}>
                    {a.agentName ?? a.agentEmail}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={rfSort}
              onValueChange={(v) => {
                setRfSort(v as typeof rfSort);
                setRfPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Urutkan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Terbaru</SelectItem>
                <SelectItem value="severity">Severity</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Waktu</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Penjelasan AI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(redFlags?.redFlags ?? []).map((f) => (
                  <TableRow
                    key={f.id}
                    className="cursor-pointer"
                    onClick={() => setDrawerFlag(f)}
                  >
                    <TableCell className="whitespace-nowrap text-sm">
                      {fmtDateTime(f.occurredAt)}
                    </TableCell>
                    <TableCell>{f.agentName ?? "-"}</TableCell>
                    <TableCell>{f.contactName ?? "-"}</TableCell>
                    <TableCell className="capitalize">{f.channelType ?? "-"}</TableCell>
                    <TableCell>
                      <ViolationBadge type={f.violationType} />
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={f.violationSeverity} />
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                      {f.aiExplanation}
                    </TableCell>
                  </TableRow>
                ))}
                {(redFlags?.redFlags ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      Tidak ada red flag. 🎉
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {redFlags && redFlags.total > redFlags.limit && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={rfPage <= 1} onClick={() => setRfPage((p) => p - 1)}>
                Sebelumnya
              </Button>
              <span className="text-sm text-muted-foreground">
                {rfPage} / {Math.ceil(redFlags.total / redFlags.limit)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={rfPage >= Math.ceil(redFlags.total / redFlags.limit)}
                onClick={() => setRfPage((p) => p + 1)}
              >
                Berikutnya
              </Button>
            </div>
          )}
        </TabsContent>

        {/* ── TAB 5: Percakapan ── */}
        <TabsContent value="percakapan" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(convAgentId || "")}
              onValueChange={(v) => {
                setConvAgent(v);
                setConvPage(1);
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Pilih agent" />
              </SelectTrigger>
              <SelectContent>
                {(results.agents ?? []).map((a) => (
                  <SelectItem key={a.agentUserId} value={String(a.agentUserId)}>
                    {a.agentName ?? a.agentEmail}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={convRedFlagOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setConvRedFlagOnly((v) => !v);
                setConvPage(1);
              }}
            >
              Ada red flag
            </Button>
            <Button
              variant={convComplaintOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setConvComplaintOnly((v) => !v);
                setConvPage(1);
              }}
            >
              Ada komplain
            </Button>
            <Select value={convSort} onValueChange={(v) => { setConvSort(v as typeof convSort); setConvPage(1); }}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Urutkan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Terbaru</SelectItem>
                <SelectItem value="score_asc">Skor terendah</SelectItem>
                <SelectItem value="response_desc">Response time terlama</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Periode Chat</TableHead>
                  <TableHead className="text-right">Skor</TableHead>
                  <TableHead className="text-right">Avg Balas</TableHead>
                  <TableHead>Komplain</TableHead>
                  <TableHead>Red Flag</TableHead>
                  <TableHead>Catatan AI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(conversations?.conversations ?? []).map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => setDrawerConv(c)}>
                    <TableCell className="font-medium">{c.contactName ?? "-"}</TableCell>
                    <TableCell className="capitalize">{c.channelType ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {fmtDateTime(c.firstMessageAt)} – {fmtDateTime(c.lastMessageAt)}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {c.convTotalScore != null ? c.convTotalScore.toFixed(0) : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.avgResponseTimeMinutes != null
                        ? `${Math.round(c.avgResponseTimeMinutes)} mnt`
                        : "-"}
                    </TableCell>
                    <TableCell>{c.hasComplaint ? "✓" : "-"}</TableCell>
                    <TableCell>
                      {(c.redFlagTypes?.length ?? 0) > 0 ? (
                        <span className="font-semibold text-red-600">
                          {c.redFlagTypes!.length} 🔴
                        </span>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-sm text-muted-foreground">
                      {c.aiNotes ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {(conversations?.conversations ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      Tidak ada percakapan.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {conversations && conversations.total > conversations.limit && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={convPage <= 1} onClick={() => setConvPage((p) => p - 1)}>
                Sebelumnya
              </Button>
              <span className="text-sm text-muted-foreground">
                {convPage} / {Math.ceil(conversations.total / conversations.limit)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={convPage >= Math.ceil(conversations.total / conversations.limit)}
                onClick={() => setConvPage((p) => p + 1)}
              >
                Berikutnya
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <AgentDetailDrawer
        jobId={jobId}
        agentId={drawerAgent}
        weights={w}
        onClose={() => setDrawerAgent(null)}
        onShowConversations={(id) => {
          setDrawerAgent(null);
          setConvAgent(String(id));
          setTab("percakapan");
        }}
        onShowRedFlags={(id) => {
          setDrawerAgent(null);
          setRfAgent(String(id));
          setTab("redflags");
        }}
      />
      <RedFlagDrawer flag={drawerFlag} onClose={() => setDrawerFlag(null)} />
      <ConversationDrawer
        conv={drawerConv}
        onClose={() => setDrawerConv(null)}
        onShowRedFlags={(id) => {
          setRfAgent(String(id));
          setRfPage(1);
          setDrawerConv(null);
          setTab("redflags");
        }}
      />
    </div>
  );
}
