import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWhatsappStatus,
  useGetAnalyticsSummary,
  useListChats,
  useConnectWhatsapp,
  useDisconnectWhatsapp,
  getGetWhatsappStatusQueryKey,
  getGetAnalyticsSummaryQueryKey,
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
} from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";

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

export default function Dashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: status, isLoading: statusLoading } = useGetWhatsappStatus({
    query: { refetchInterval: 3000 },
  });
  const { data: summary, isLoading: summaryLoading } = useGetAnalyticsSummary();
  const { data: chats } = useListChats();

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
                  onClick={() => connect.mutate({})}
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
                  onClick={() => disconnect.mutate({})}
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
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(status.qrCode)}&format=svg`}
                  alt="WhatsApp QR Code"
                  width={180}
                  height={180}
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
                color="bg-blue-500/10 text-blue-400"
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
                color="bg-violet-500/10 text-violet-400"
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
