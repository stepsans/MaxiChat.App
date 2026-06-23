import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useGetDashboard,
  getGetDashboardQueryKey,
  useGetMyWorkboardTasks,
  getGetMyWorkboardTasksQueryKey,
  useListChats,
  getListChatsQueryKey,
  useGetOnboardingChecklist,
  getGetOnboardingChecklistQueryKey,
  type DashboardOverview,
  type WorkboardMyTasks,
  type Chat,
} from "@workspace/api-client-react";

import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Skeleton } from "@/components/Skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

// ── formatting helpers ────────────────────────────────────────────────────────
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function formatTanggal(d: Date): string {
  return `${HARI[d.getDay()]}, ${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

// Thousands separator with a dot (id-ID style) — done manually so it doesn't
// depend on the Hermes Intl build.
function ribuan(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function firstName(name?: string | null, email?: string | null): string {
  const base = (name ?? "").trim();
  if (base) return base.split(/\s+/)[0];
  return (email ?? "").split("@")[0] || "";
}

function menitLalu(iso?: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} mnt`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam`;
  return `${Math.floor(hours / 24)} hr`;
}

function mbFromBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

type Tone = "primary" | "danger" | "success" | "info";

// ── small building blocks ─────────────────────────────────────────────────────
function SectionTitle({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const colors = useColors();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <Text style={[styles.sectionAction, { color: colors.primary }]}>{action.label} ›</Text>
        </Pressable>
      )}
    </View>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
  onPress,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: keyof typeof Feather.glyphMap;
  tone: Tone;
  onPress?: () => void;
}) {
  const colors = useColors();
  const toneColor =
    tone === "danger" ? colors.danger
    : tone === "success" ? colors.success
    : tone === "info" ? colors.info
    : colors.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={[styles.cardIcon, { backgroundColor: toneColor + "1f" }]}>
        <Feather name={icon} size={18} color={toneColor} />
      </View>
      <Text style={[styles.cardValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.cardLabel, { color: colors.mutedForeground }]} numberOfLines={2}>
        {label}
      </Text>
      {sub ? <Text style={[styles.cardSub, { color: colors.success }]}>{sub}</Text> : null}
    </Pressable>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const colors = useColors();
  const toneColor =
    tone === "danger" ? colors.danger
    : tone === "success" ? colors.success
    : tone === "info" ? colors.info
    : colors.primary;
  return (
    <View style={[styles.mini, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.miniValue, { color: toneColor }]}>{value}</Text>
      <Text style={[styles.miniLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function PriorityStrip({ priority }: { priority: string }) {
  const colors = useColors();
  const c =
    priority === "high" ? colors.danger
    : priority === "low" ? colors.mutedForeground
    : colors.warning;
  return <View style={[styles.strip, { backgroundColor: c }]} />;
}

function Avatar({ url, name }: { url?: string | null; name?: string | null }) {
  const colors = useColors();
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        recyclingKey={url}
        cachePolicy="memory-disk"
        transition={120}
        contentFit="cover"
        style={styles.avatar}
      />
    );
  }
  return (
    <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.primarySoft }]}>
      <Text style={[styles.avatarText, { color: colors.primaryDark }]}>{initial}</Text>
    </View>
  );
}

// ── task row (shared by owner + agent views) ──────────────────────────────────
type TaskLike = {
  taskId: number;
  boardName: string;
  boardEmoji?: string | null;
  boardColor: string;
  title: string;
  dueDate?: string | null;
  priority: string;
  mentionedBy?: string | null;
};

function TaskRow({ task, last }: { task: TaskLike; last: boolean }) {
  const colors = useColors();
  const meta = task.mentionedBy
    ? `Di-mention oleh ${task.mentionedBy}`
    : task.dueDate
      ? `Tenggat ${formatTanggal(new Date(task.dueDate))}`
      : "Tanpa tenggat";
  return (
    <Pressable
      onPress={() => router.push("/(tabs)/workboard")}
      style={[
        styles.taskRow,
        !last && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <PriorityStrip priority={task.priority} />
      <Text style={styles.taskEmoji}>{task.boardEmoji ?? "📋"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.taskTitle, { color: colors.foreground }]} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={[styles.taskMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <View style={[styles.boardBadge, { backgroundColor: task.boardColor + "22" }]}>
        <Text style={[styles.boardBadgeText, { color: task.boardColor }]} numberOfLines={1}>
          {task.boardName}
        </Text>
      </View>
    </Pressable>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {children}
    </View>
  );
}

function EmptyLine({ text }: { text: string }) {
  const colors = useColors();
  return <Text style={[styles.empty, { color: colors.mutedForeground }]}>{text}</Text>;
}

// Inline per-section failure (e.g. the queue or tasks fetch errored while the
// rest of the dashboard loaded). Keeps the working sections visible instead of
// silently rendering an empty state that looks like "no data".
function ErrorLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.errorLine}>
      <Feather name="alert-triangle" size={14} color={colors.danger} />
      <Text style={[styles.empty, { color: colors.danger, flex: 1 }]}>{text}</Text>
      <Pressable onPress={onRetry} hitSlop={8}>
        <Text style={[styles.sectionAction, { color: colors.primary }]}>Coba lagi ›</Text>
      </Pressable>
    </View>
  );
}

// Instant loading placeholder — mirrors the dashboard's coarse layout (greeting,
// health pills, a stat grid, and a list card) so the screen never flashes blank.
function DashboardSkeleton({ insetBottom }: { insetBottom: number }) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: insetBottom + 24, gap: 12 }}
      scrollEnabled={false}
    >
      <Skeleton width="50%" height={22} />
      <Skeleton width="35%" height={13} />
      <View style={styles.healthRow}>
        <Skeleton height={64} radius={14} style={{ flex: 1 }} />
        <Skeleton height={64} radius={14} style={{ flex: 1 }} />
      </View>
      <View style={styles.grid}>
        <Skeleton height={108} radius={16} style={{ width: "47%", flexGrow: 1 }} />
        <Skeleton height={108} radius={16} style={{ width: "47%", flexGrow: 1 }} />
        <Skeleton height={108} radius={16} style={{ width: "47%", flexGrow: 1 }} />
      </View>
      <Skeleton height={120} radius={16} />
      <Skeleton height={120} radius={16} />
    </ScrollView>
  );
}

// ── screen ────────────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { activeChannelId } = useChannel();

  const isAgent = user?.teamRole === "agent";
  const isOwner = user?.teamRole === "super_admin";
  const today = formatTanggal(new Date());

  // L4 onboarding banner — owner only. healthScore is the setup-completion
  // percent; the banner hides once setup is complete (100%).
  const onboarding = useGetOnboardingChecklist({
    query: { queryKey: getGetOnboardingChecklistQueryKey(), enabled: isOwner },
  });
  const setupPct = onboarding.data?.healthScore ?? 100;
  const showSetupBanner = isOwner && onboarding.data != null && setupPct < 100;

  // Agents never load analytics (dashboard.view is false for them); they only
  // see their WorkBoard tasks. Owner/Supervisor load the full aggregate.
  // activeChannelId is part of the key so switching the channel chip refetches
  // (the scope is sent via the X-Channel-Id header, which the key doesn't see).
  const dash = useGetDashboard({
    query: {
      queryKey: [...getGetDashboardQueryKey(), activeChannelId],
      enabled: !isAgent && activeChannelId != null,
      refetchInterval: 30000,
    },
  });
  const queue = useListChats(
    { status: "needs_human" },
    {
      query: {
        queryKey: [...getListChatsQueryKey({ status: "needs_human" }), activeChannelId],
        enabled: !isAgent && activeChannelId != null,
      },
    },
  );
  const tasks = useGetMyWorkboardTasks({
    query: { queryKey: getGetMyWorkboardTasksQueryKey(), refetchInterval: 60000 },
  });

  const loading = isAgent ? tasks.isLoading : dash.isLoading;
  const isError = isAgent ? tasks.isError : dash.isError;
  // Manual-refresh flag so the pull spinner shows only during an explicit pull,
  // never on the silent 30s/60s background polls (spec §10).
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all(
        isAgent
          ? [tasks.refetch()]
          : [tasks.refetch(), dash.refetch(), queue.refetch()],
      );
    } finally {
      setRefreshing(false);
    }
  }, [isAgent, tasks, dash, queue]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Dashboard" right={<ChannelSwitcher />} />

      {loading ? (
        <DashboardSkeleton insetBottom={insets.bottom} />
      ) : isError ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={28} color={colors.danger} />
          <Text style={[styles.emptyTitle, { color: colors.foreground, marginTop: 8 }]}>
            Gagal memuat dashboard
          </Text>
          <Pressable onPress={onRefresh} hitSlop={8} style={{ marginTop: 8 }}>
            <Text style={[styles.sectionAction, { color: colors.primary }]}>Coba lagi ›</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {/* L2-L3 greeting + date */}
          <Text style={[styles.hello, { color: colors.foreground }]}>
            Halo, {firstName(user?.name, user?.email)} 👋
          </Text>
          <Text style={[styles.date, { color: colors.mutedForeground }]}>{today}</Text>

          {showSetupBanner && (
            <Pressable
              onPress={() => router.push("/(tabs)/settings")}
              style={[styles.banner, { backgroundColor: colors.primarySoft, borderColor: colors.primary + "55" }]}
            >
              <View style={[styles.bannerIcon, { backgroundColor: colors.primary }]}>
                <Feather name="zap" size={16} color={colors.primaryForeground} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.bannerTitle, { color: colors.primaryDark }]}>
                  Setup {setupPct}% selesai
                </Text>
                <Text style={[styles.bannerSub, { color: colors.primaryDark }]}>
                  Lengkapi setup akun Anda
                </Text>
                <View style={[styles.bannerBar, { backgroundColor: colors.primary + "33" }]}>
                  <View style={[styles.bannerBarFill, { width: `${setupPct}%`, backgroundColor: colors.primary }]} />
                </View>
              </View>
              <Feather name="chevron-right" size={20} color={colors.primaryDark} />
            </Pressable>
          )}

          {isAgent ? (
            <AgentView
              tasks={tasks.data}
              tasksError={tasks.isError}
              onRetryTasks={() => tasks.refetch()}
              colors={colors}
            />
          ) : (
            <OwnerView
              dash={dash.data}
              queue={queue.data}
              tasks={tasks.data}
              queueError={queue.isError}
              tasksError={tasks.isError}
              onRetryQueue={() => queue.refetch()}
              onRetryTasks={() => tasks.refetch()}
              colors={colors}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ── Owner / Supervisor: full dashboard ────────────────────────────────────────
function OwnerView({
  dash,
  queue,
  tasks,
  queueError,
  tasksError,
  onRetryQueue,
  onRetryTasks,
  colors,
}: {
  dash: DashboardOverview | undefined;
  queue: Chat[] | undefined;
  tasks: WorkboardMyTasks | undefined;
  queueError: boolean;
  tasksError: boolean;
  onRetryQueue: () => void;
  onRetryTasks: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  // Per-phone isolation: no channel / no chats → empty state, not a wall of 0s.
  const noData = !dash || dash.summary.totalChats === 0;

  const labels = dash?.summary.chatsByLabel ?? [];
  const maxLabel = labels.reduce((m, l) => Math.max(m, l.count), 0);
  const queueRows = (queue ?? []).slice(0, 3);

  // Merge assigned + mentioned tasks for the combined section (assigned wins).
  const merged: TaskLike[] = [];
  const seen = new Set<number>();
  for (const t of tasks?.assigned ?? []) {
    if (seen.has(t.taskId)) continue;
    seen.add(t.taskId);
    merged.push(t);
  }
  for (const t of tasks?.mentioned ?? []) {
    if (seen.has(t.taskId)) continue;
    seen.add(t.taskId);
    merged.push({ ...t, mentionedBy: t.mentionedBy });
  }
  const taskRows = merged.slice(0, 3);

  const credit = dash?.health.aiCredit ?? null;
  const remainingPct = credit ? Math.max(0, 100 - credit.usagePercent) : 0;
  const creditColor =
    remainingPct < 5 ? colors.danger : remainingPct < 20 ? colors.warning : colors.success;

  return (
    <>
      {/* L6-L7 System Health */}
      <SectionTitle title="System Health" />
      <View style={styles.healthRow}>
        <Pressable
          onPress={() => router.push("/(tabs)/settings")}
          style={[styles.pill, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <View style={styles.pillHead}>
            <Feather
              name="wifi"
              size={14}
              color={dash?.health.channels.anyConnected ? colors.success : colors.danger}
            />
            <Text
              style={[
                styles.pillStatus,
                { color: dash?.health.channels.anyConnected ? colors.success : colors.danger },
              ]}
            >
              {dash?.health.channels.anyConnected ? "Tersambung" : "Terputus"}
            </Text>
          </View>
          <Text style={[styles.pillSub, { color: colors.mutedForeground }]}>
            {dash?.health.channels.connected ?? 0} channel aktif
          </Text>
        </Pressable>

        {credit && (
          <View style={[styles.pill, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.pillHead}>
              <Feather name="zap" size={14} color={creditColor} />
              <Text style={[styles.pillStatus, { color: colors.foreground }]}>Kredit AI</Text>
            </View>
            <Text style={[styles.pillSub, { color: colors.mutedForeground }]}>
              {remainingPct}% · {ribuan(credit.tokenRemaining)} token
            </Text>
            <View style={[styles.bar, { backgroundColor: colors.border }]}>
              <View
                style={[styles.barFill, { width: `${remainingPct}%`, backgroundColor: creditColor }]}
              />
            </View>
          </View>
        )}
      </View>

      {noData ? (
        <Card>
          <View style={styles.emptyBlock}>
            <Feather name="message-square" size={28} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Belum ada data</Text>
            <EmptyLine text="Hubungkan WhatsApp untuk melihat ringkasan." />
          </View>
        </Card>
      ) : (
        <>
          {/* L8-L15 Ringkasan */}
          <SectionTitle title="Ringkasan" />
          {/* 3 stat cards (L9/L11/L12). AI Handled (L13) & the "Perlu Dibalas"
              count card (L10) are intentionally removed (founder call §5-1/§5-2);
              the queue lives as a list below (L16–L17). */}
          <View style={styles.grid}>
            <StatCard
              label="Total Chat"
              value={ribuan(dash!.summary.totalChats)}
              sub={dash!.summary.todayChats > 0 ? `+${dash!.summary.todayChats} hari ini` : undefined}
              icon="message-square"
              tone="primary"
              onPress={() => router.push("/(tabs)")}
            />
            <StatCard
              label="Leads"
              value={ribuan(dash!.summary.leads)}
              icon="user-check"
              tone="success"
              onPress={() => router.push({ pathname: "/(tabs)", params: { filter: "leads" } })}
            />
            <StatCard
              label="Lead Rate"
              value={`${dash!.summary.leadRate}%`}
              icon="trending-up"
              tone="info"
            />
          </View>
          {/* L14 Not Leads + L15 Total Pesan as mini stats. */}
          <View style={styles.miniRow}>
            <MiniStat label="Not Leads" value={ribuan(dash!.summary.notLeads)} tone="danger" />
            <MiniStat label="Total Pesan" value={ribuan(dash!.summary.totalMessages)} tone="primary" />
          </View>
        </>
      )}

      {/* L16-L17 Antrian Perlu Dibalas */}
      <SectionTitle title="Antrian Perlu Dibalas" action={{ label: "Lihat semua", onPress: () => router.push("/(tabs)") }} />
      <Card>
        {queueRows.length > 0 ? (
          queueRows.map((c, i) => (
            <Pressable
              key={c.id}
              onPress={() => router.push(`/chat/${c.id}`)}
              style={[
                styles.queueRow,
                i < queueRows.length - 1 && {
                  borderBottomColor: colors.border,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Avatar url={c.profilePicUrl} name={c.contactName} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.queueName, { color: colors.foreground }]} numberOfLines={1}>
                  {c.contactName}
                </Text>
                <Text style={[styles.queueMsg, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {c.lastMessage ?? ""}
                </Text>
              </View>
              <Text style={[styles.queueTime, { color: colors.mutedForeground }]}>
                {menitLalu(c.lastMessageAt)}
              </Text>
            </Pressable>
          ))
        ) : queueError ? (
          <ErrorLine text="Gagal memuat antrian" onRetry={onRetryQueue} />
        ) : (
          <EmptyLine text="Tidak ada antrian 🎉" />
        )}
      </Card>

      {/* L17a-L17b Tugas WorkBoard untuk Kamu */}
      <SectionTitle title="Tugas WorkBoard untuk Kamu" action={{ label: "Workboard", onPress: () => router.push("/(tabs)/workboard") }} />
      <Card>
        {taskRows.length > 0 ? (
          taskRows.map((t, i) => <TaskRow key={t.taskId} task={t} last={i === taskRows.length - 1} />)
        ) : tasksError ? (
          <ErrorLine text="Gagal memuat tugas" onRetry={onRetryTasks} />
        ) : (
          <EmptyLine text="Tidak ada tugas" />
        )}
      </Card>

      {/* L18-L19 Chat per Label */}
      {labels.length > 0 && (
        <>
          <SectionTitle title="Chat per Label" />
          <Card>
            <View style={{ padding: 14, gap: 10 }}>
              {labels.slice(0, 5).map((l) => (
                <Pressable
                  key={l.id}
                  onPress={() => router.push({ pathname: "/(tabs)", params: { label: String(l.id) } })}
                  style={styles.labelRow}
                >
                  <Text style={[styles.labelName, { color: colors.foreground }]} numberOfLines={1}>
                    {l.name}
                  </Text>
                  <View style={[styles.labelTrack, { backgroundColor: colors.border }]}>
                    <View
                      style={{
                        height: "100%",
                        borderRadius: 4,
                        backgroundColor: l.color,
                        width: `${maxLabel > 0 ? Math.max(8, (l.count / maxLabel) * 100) : 0}%`,
                      }}
                    />
                  </View>
                  <Text style={[styles.labelCount, { color: colors.mutedForeground }]}>{l.count}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        </>
      )}

      {/* L20-L21 Pertanyaan Teratas */}
      {dash && dash.commonQuestions.length > 0 && (
        <>
          <SectionTitle title="Pertanyaan Teratas" />
          <Card>
            {dash.commonQuestions.slice(0, 3).map((q, i) => (
              <View
                key={`${q.question}-${i}`}
                style={[
                  styles.qRow,
                  i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <View style={[styles.qRank, { backgroundColor: colors.primarySoft }]}>
                  <Text style={[styles.qRankText, { color: colors.primaryDark }]}>{i + 1}</Text>
                </View>
                <Text style={[styles.qText, { color: colors.foreground }]} numberOfLines={2}>
                  {q.question}
                </Text>
                <Text style={[styles.qCount, { color: colors.mutedForeground }]}>{q.count}×</Text>
              </View>
            ))}
          </Card>
        </>
      )}

      {/* L22 Penyimpanan data */}
      {dash && (
        <Text style={[styles.storage, { color: colors.mutedForeground }]}>
          {ribuan(dash.storage.chatCount)} chat · {ribuan(dash.storage.messageCount)} pesan · ±
          {mbFromBytes(dash.storage.estimatedBytes)} MB
        </Text>
      )}
    </>
  );
}

// ── Agent: WorkBoard tasks only ───────────────────────────────────────────────
function AgentView({
  tasks,
  tasksError,
  onRetryTasks,
  colors,
}: {
  tasks: WorkboardMyTasks | undefined;
  tasksError: boolean;
  onRetryTasks: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const assigned = tasks?.assigned ?? [];
  const mentioned = tasks?.mentioned ?? [];
  const counts = tasks?.counts ?? { active: 0, dueToday: 0, mentioned: 0 };

  return (
    <>
      <View style={styles.miniRow}>
        <MiniStat label="Tugas Aktif" value={String(counts.active)} tone="primary" />
        <MiniStat label="Hari Ini" value={String(counts.dueToday)} tone="info" />
        <MiniStat label="Di-mention" value={String(counts.mentioned)} tone="success" />
      </View>

      <SectionTitle title="Harus Dikerjakan" action={{ label: "Workboard", onPress: () => router.push("/(tabs)/workboard") }} />
      <Card>
        {assigned.length > 0 ? (
          assigned.map((t, i) => <TaskRow key={t.taskId} task={t} last={i === assigned.length - 1} />)
        ) : tasksError ? (
          <ErrorLine text="Gagal memuat tugas" onRetry={onRetryTasks} />
        ) : (
          <EmptyLine text="Tidak ada tugas" />
        )}
      </Card>

      <SectionTitle title="Kamu Di-mention" />
      <Card>
        {mentioned.length > 0 ? (
          mentioned.map((t, i) => (
            <TaskRow key={t.taskId} task={{ ...t, mentionedBy: t.mentionedBy }} last={i === mentioned.length - 1} />
          ))
        ) : tasksError ? (
          <ErrorLine text="Gagal memuat mention" onRetry={onRetryTasks} />
        ) : (
          <EmptyLine text="Belum ada mention" />
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hello: { fontFamily: "Inter_700Bold", fontSize: 20 },
  date: { fontFamily: "Inter_400Regular", fontSize: 13, marginBottom: 4 },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginTop: 6,
  },
  bannerIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bannerTitle: { fontFamily: "Inter_700Bold", fontSize: 14 },
  bannerSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  bannerBar: { height: 5, borderRadius: 3, overflow: "hidden", marginTop: 6 },
  bannerBarFill: { height: "100%", borderRadius: 3 },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    marginBottom: 8,
  },
  sectionTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  sectionAction: { fontFamily: "Inter_600SemiBold", fontSize: 13 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  card: {
    width: "47%",
    flexGrow: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 6,
  },
  cardIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  cardValue: { fontFamily: "Inter_700Bold", fontSize: 26 },
  cardLabel: { fontFamily: "Inter_500Medium", fontSize: 13 },
  cardSub: { fontFamily: "Inter_600SemiBold", fontSize: 12 },

  miniRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  mini: {
    flex: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 2,
  },
  miniValue: { fontFamily: "Inter_700Bold", fontSize: 20 },
  miniLabel: { fontFamily: "Inter_500Medium", fontSize: 12 },

  healthRow: { flexDirection: "row", gap: 12 },
  pill: {
    flex: 1,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 4,
  },
  pillHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  pillStatus: { fontFamily: "Inter_700Bold", fontSize: 14 },
  pillSub: { fontFamily: "Inter_400Regular", fontSize: 12 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden", marginTop: 4 },
  barFill: { height: "100%", borderRadius: 3 },

  listCard: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  empty: { fontFamily: "Inter_400Regular", fontSize: 14, textAlign: "center", paddingVertical: 24 },
  emptyBlock: { alignItems: "center", gap: 6, paddingVertical: 24 },
  errorLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 14, paddingHorizontal: 14 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 15 },

  queueRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  queueName: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  queueMsg: { fontFamily: "Inter_400Regular", fontSize: 13, marginTop: 1 },
  queueTime: { fontFamily: "Inter_500Medium", fontSize: 11 },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: "Inter_700Bold", fontSize: 15 },

  taskRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 14, paddingVertical: 12 },
  strip: { width: 4, alignSelf: "stretch", borderTopLeftRadius: 2, borderBottomLeftRadius: 2 },
  taskEmoji: { fontSize: 18, marginLeft: 6 },
  taskTitle: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  taskMeta: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  boardBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 96 },
  boardBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },

  labelRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  labelName: { fontFamily: "Inter_500Medium", fontSize: 13, width: 90 },
  labelTrack: { flex: 1, height: 8, borderRadius: 4, overflow: "hidden" },
  labelCount: { fontFamily: "Inter_600SemiBold", fontSize: 12, width: 34, textAlign: "right" },

  qRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  qRank: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  qRankText: { fontFamily: "Inter_700Bold", fontSize: 12 },
  qText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 14 },
  qCount: { fontFamily: "Inter_600SemiBold", fontSize: 13 },

  storage: { fontFamily: "Inter_400Regular", fontSize: 12, textAlign: "center", marginTop: 18 },
});
