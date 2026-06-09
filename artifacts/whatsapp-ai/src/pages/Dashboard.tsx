import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWhatsappStatus,
  useGetAnalyticsSummary,
  useListChats,
  useConnectWhatsapp,
  useDisconnectWhatsapp,
  useGetStorageUsage,
  useGetMyQuota,
  getGetWhatsappStatusQueryKey,
  getGetAnalyticsSummaryQueryKey,
  getListChatsQueryKey,
  getGetStorageUsageQueryKey,
  getGetMyQuotaQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare,
  Bot,
  UserCheck,
  Flame,
  TrendingUp,
  Users,
  Wifi,
  WifiOff,
  QrCode,
  Loader2,
  CheckCircle,
  ShieldAlert,
  HardDrive,
  Gauge,
  Layers,
  Coins,
  AlertTriangle,
} from "lucide-react";
import { Link } from "wouter";
import { cn, formatBytes } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { useEffect } from "react";

// Convert a label's hex color into translucent fill/border so the count chip
// reads as a soft tint with the label color as text — consistent with the
// tag/status badge styling used elsewhere in the app.
function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const full =
    m.length === 3 ? m.split("").map((c) => c + c).join("") : m.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
const labelChipBg = (hex: string) => hexToRgba(hex, 0.15);
const labelChipBorder = (hex: string) => hexToRgba(hex, 0.35);

function StatCard({
  title,
  value,
  icon: Icon,
  color,
  sub,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
  sub?: string;
}) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              {title}
            </p>
            <p className="text-2xl font-bold mt-1 text-foreground">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={cn("p-2 rounded-md", color)}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function QuotaBar({
  label,
  icon: Icon,
  used,
  limit,
  format,
  unit,
  testId,
  unlimited = false,
  warnPercent = 80,
  enforced = false,
}: {
  label: string;
  icon: React.ElementType;
  used: number;
  limit: number;
  format: (n: number) => string;
  unit?: string;
  testId: string;
  unlimited?: boolean;
  warnPercent?: number;
  enforced?: boolean;
}) {
  // Owner Infinity: render ∞ with no progress bar / near-limit warning.
  const hasLimit = !unlimited && limit > 0;
  const pct = hasLimit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // Near-limit threshold; for storage this is operator-configured (FASE C).
  const threshold = warnPercent > 0 && warnPercent <= 100 ? warnPercent : 80;
  const warn = hasLimit && pct >= threshold;
  const barColor = warn ? "bg-amber-500" : "bg-cyan-500";
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          {label}
          {warn && (
            <AlertTriangle
              className="w-3.5 h-3.5 text-amber-500"
              data-testid={`${testId}-warning`}
            />
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {format(used)}
          {unlimited ? " / ∞" : hasLimit ? ` / ${format(limit)}` : ` / ∞`}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      {unlimited ? (
        <p className="text-[11px] mt-1 text-cyan-500" data-testid={`${testId}-unlimited`}>
          Tidak terbatas
        </p>
      ) : (
        <>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", barColor)}
              style={{ width: `${hasLimit ? pct : 0}%` }}
            />
          </div>
          {hasLimit && (
            <p
              className={cn(
                "text-[11px] mt-1 tabular-nums",
                warn ? "text-amber-500" : "text-muted-foreground"
              )}
            >
              {pct}% terpakai
              {warn
                ? enforced
                  ? " — mendekati batas, unggahan baru akan diblokir"
                  : " — mendekati batas kuota"
                : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function Dashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { menus, isLoading: permLoading } = usePermissions();
  const canView = menus.dashboard.canView;

  const { data: status, isLoading: statusLoading } = useGetWhatsappStatus({
    query: {
      queryKey: getGetWhatsappStatusQueryKey(),
      refetchInterval: 3000,
      enabled: canView,
    },
  });
  const { data: summary, isLoading: summaryLoading } = useGetAnalyticsSummary({
    query: { queryKey: getGetAnalyticsSummaryQueryKey(), enabled: canView },
  });
  const { data: chats } = useListChats(undefined, {
    query: { queryKey: getListChatsQueryKey(), enabled: canView },
  });
  const { data: storage, isLoading: storageLoading } = useGetStorageUsage({
    query: { queryKey: getGetStorageUsageQueryKey(), enabled: canView },
  });
  const { data: quota, isLoading: quotaLoading } = useGetMyQuota({
    query: { queryKey: getGetMyQuotaQueryKey(), enabled: canView },
  });

  const connect = useConnectWhatsapp({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        toast({ title: "QR code generated. Scan with WhatsApp." });
      },
    },
  });

  const disconnect = useDisconnectWhatsapp({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        toast({ title: "WhatsApp disconnected." });
      },
    },
  });

  const isConnected = status?.status === "connected";
  const isQrReady = status?.status === "qr_ready";
  const isConnecting = status?.status === "connecting";

  const needsHumanChats = chats?.filter((c) => c.status === "needs_human") ?? [];

  // Route is unguarded — self-guard so a user without dashboard.view who
  // navigates here directly gets a clear message instead of 403-driven blanks.
  if (!permLoading && !menus.dashboard.canView) {
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
              Anda tidak memiliki izin untuk melihat Dashboard.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold text-foreground">Dashboard</h1>
          <p className="text-xs text-muted-foreground">AI automation overview</p>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Onboarding checklist — hides itself at 100% health */}
        <OnboardingChecklist />

        {/* WhatsApp Connection */}
        <Card data-testid="whatsapp-connection-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">WhatsApp Connection</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-medium",
                  isConnected
                    ? "bg-primary/10 text-primary border-primary/20"
                    : isQrReady || isConnecting
                    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                    : "bg-red-500/10 text-red-400 border-red-500/20"
                )}
              >
                {isConnected ? (
                  <CheckCircle className="w-4 h-4" />
                ) : isQrReady || isConnecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <WifiOff className="w-4 h-4" />
                )}
                {isConnected
                  ? `Connected${status?.phoneNumber ? ` · ${status.phoneNumber}` : ""}`
                  : isQrReady
                  ? "Scan QR code to connect"
                  : isConnecting
                  ? "Connecting..."
                  : "Not connected"}
              </div>

              {!isConnected && (
                <Button
                  data-testid="button-connect-whatsapp"
                  size="sm"
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending || isQrReady || isConnecting}
                >
                  {connect.isPending || isConnecting ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <QrCode className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {isQrReady ? "Scan QR Code" : "Connect WhatsApp"}
                </Button>
              )}

              {isConnected && (
                <Button
                  data-testid="button-disconnect-whatsapp"
                  size="sm"
                  variant="outline"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </Button>
              )}
            </div>

            {isQrReady && status?.qrCode && (
              <div className="mt-4 p-4 bg-white rounded-lg inline-block" data-testid="qr-code-display">
                <p className="text-xs text-gray-600 font-medium mb-3 text-center">
                  Scan dengan WhatsApp di HP kamu
                </p>
                <img
                  src={status.qrCode}
                  alt="WhatsApp QR Code"
                  width={220}
                  height={220}
                  className="rounded"
                />
                <p className="text-[10px] text-gray-400 text-center mt-2">
                  QR kedaluwarsa dalam 60 detik
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {summaryLoading ? (
            Array(8)
              .fill(0)
              .map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)
          ) : (
            <>
              <StatCard
                title="Total Chats"
                value={summary?.totalChats ?? 0}
                icon={MessageSquare}
                color="bg-orange-500/10 text-orange-400"
                sub={`${summary?.todayChats ?? 0} today`}
              />
              <StatCard
                title="AI Handled"
                value={summary?.aiHandled ?? 0}
                icon={Bot}
                color="bg-primary/10 text-primary"
              />
              <StatCard
                title="Needs Human"
                value={summary?.needsHuman ?? 0}
                icon={UserCheck}
                color="bg-yellow-500/10 text-yellow-400"
              />
              <StatCard
                title="Closing Rate"
                value={`${summary?.closingRate ?? 0}%`}
                icon={TrendingUp}
                color="bg-emerald-500/10 text-emerald-400"
              />
              <StatCard
                title="Hot Leads"
                value={summary?.hotLeads ?? 0}
                icon={Flame}
                color="bg-orange-500/10 text-orange-400"
              />
              <StatCard
                title="Closing Leads"
                value={summary?.closingLeads ?? 0}
                icon={TrendingUp}
                color="bg-amber-500/10 text-amber-400"
              />
              <StatCard
                title="Cold Leads"
                value={summary?.coldLeads ?? 0}
                icon={Users}
                color="bg-slate-500/10 text-slate-400"
              />
              <StatCard
                title="Total Messages"
                value={summary?.totalMessages ?? 0}
                icon={MessageSquare}
                color="bg-cyan-500/10 text-cyan-400"
              />
            </>
          )}
        </div>

        {/* Data Usage */}
        <Card data-testid="storage-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              Penggunaan Data Chat
            </CardTitle>
          </CardHeader>
          <CardContent>
            {storageLoading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-bytes">
                    {formatBytes(storage?.estimatedBytes)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Total data tersimpan</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-chats">
                    {storage?.chatCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Chat</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground" data-testid="storage-messages">
                    {storage?.messageCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Pesan</p>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-3">
              Estimasi ukuran data chat di seluruh channel akun ini.
            </p>
          </CardContent>
        </Card>

        {/* Quota Usage */}
        <Card data-testid="quota-usage-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Gauge className="w-4 h-4 text-cyan-400" />
              Penggunaan Kuota
            </CardTitle>
          </CardHeader>
          <CardContent>
            {quotaLoading || !quota ? (
              <Skeleton className="h-32 rounded-lg" />
            ) : (
              <div className="space-y-4">
                <QuotaBar
                  label="Penyimpanan media"
                  icon={HardDrive}
                  used={quota.usage.mediaStorageBytes}
                  limit={quota.storageLimit}
                  format={(n) => formatBytes(n)}
                  testId="quota-storage"
                  unlimited={quota.unlimited}
                  warnPercent={quota.storageWarnPercent ?? 80}
                  enforced={quota.storageEnforcementEnabled ?? false}
                />
                <QuotaBar
                  label="Pengguna"
                  icon={Users}
                  used={quota.usage.childUserCount}
                  limit={quota.userLimit}
                  format={(n) => `${n}`}
                  unit="user"
                  testId="quota-users"
                  unlimited={quota.unlimited}
                />
                <QuotaBar
                  label="Channel"
                  icon={Layers}
                  used={quota.usage.channelCount}
                  limit={quota.channelLimit}
                  format={(n) => `${n}`}
                  unit="channel"
                  testId="quota-channels"
                  unlimited={quota.unlimited}
                />
                <QuotaBar
                  label="Token AI"
                  icon={Coins}
                  used={quota.usage.tokenUsage}
                  limit={quota.tokenLimit}
                  format={(n) => n.toLocaleString("id-ID")}
                  unit="token"
                  testId="quota-tokens"
                  unlimited={quota.unlimited}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Chats by Label */}
        {!summaryLoading && (summary?.chatsByLabel?.length ?? 0) > 0 && (
          <Card data-testid="chats-by-label-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Chat per Label</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {summary!.chatsByLabel.map((label) => (
                  <span
                    key={label.id}
                    data-testid={`label-count-${label.id}`}
                    className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium"
                    style={{
                      backgroundColor: labelChipBg(label.color),
                      color: label.color,
                      border: `1px solid ${labelChipBorder(label.color)}`,
                    }}
                  >
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: label.color }}
                    />
                    <span>{label.name}</span>
                    <span className="font-bold tabular-nums">{label.count}</span>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Needs Human Section */}
        {needsHumanChats.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-yellow-400">
                Needs Human Attention ({needsHumanChats.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {needsHumanChats.slice(0, 5).map((chat) => (
                  <Link
                    key={chat.id}
                    href={`/chats/${chat.id}`}
                    data-testid={`needs-human-chat-${chat.id}`}
                    className="flex items-center justify-between p-3 rounded-md bg-secondary hover:bg-accent transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{chat.contactName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {chat.lastMessage ?? "No messages"}
                      </p>
                    </div>
                    <Badge variant="outline" className="border-yellow-500/30 text-yellow-400 text-[10px] ml-2 flex-shrink-0">
                      Needs Human
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
