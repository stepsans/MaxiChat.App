import { Feather } from "@expo/vector-icons";
import { keepPreviousData } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useListChats,
  useListCustomerLabels,
  useSearchChatContent,
  getListChatsQueryKey,
  getSearchChatContentQueryKey,
  ChatLeadStatus,
  type Chat,
  type CustomerLabel,
} from "@workspace/api-client-react";

import { Avatar } from "@/components/Avatar";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { ChatListSkeleton } from "@/components/Skeleton";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

type Colors = ReturnType<typeof useColors>;

// Status Lead (spec §5) — 3-state keputusan manusia, melekat ke kontak.
// Urutan siklus filter: off → Leads → Bukan Leads → Belum Tahu → off.
const LEAD_CYCLE: ChatLeadStatus[] = [
  ChatLeadStatus.lead,
  ChatLeadStatus.not_lead,
  ChatLeadStatus.unknown,
];

function leadLabel(s: ChatLeadStatus): string {
  if (s === ChatLeadStatus.lead) return "Leads";
  if (s === ChatLeadStatus.not_lead) return "Bukan Leads";
  return "Belum Tahu";
}

// Warna semantik per status lead — hijau Leads, merah Bukan Leads, abu default.
function leadColor(s: ChatLeadStatus, colors: Colors): string {
  return s === ChatLeadStatus.lead
    ? colors.success
    : s === ChatLeadStatus.not_lead
      ? colors.danger
      : colors.mutedForeground;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Kemarin";
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

const isGroupChat = (c: Chat) => c.phoneNumber.endsWith("@g.us");

// ── Memoized row ──────────────────────────────────────────────────────────────
// Module-level + React.memo with a field-level `areEqual`. The 5s poll feeds a
// new array but React Query's structural sharing keeps unchanged items' identity
// stable; combined with this comparator, only rows whose visible fields actually
// changed re-render — the rest are skipped entirely.
function labelsKey(labels: CustomerLabel[]): string {
  let k = "";
  for (let i = 0; i < labels.length && i < 3; i++) {
    k += labels[i].id + ":" + labels[i].color + ":" + labels[i].name + "|";
  }
  return k;
}

function ChatRowBase({
  item,
  colors,
  onPress,
}: {
  item: Chat;
  colors: Colors;
  onPress: (id: number) => void;
}) {
  const lead = item.leadStatus ?? ChatLeadStatus.unknown;
  const c = leadColor(lead, colors);
  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.6}
      onPress={() => onPress(item.id)}
    >
      <Avatar name={item.contactName} uri={item.profilePicUrl} size={52} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {item.nickname || item.contactName}
          </Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {timeLabel(item.lastMessageAt)}
          </Text>
        </View>
        <View style={styles.rowBottom}>
          <Text
            style={[styles.preview, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {item.lastMessage || "Belum ada pesan"}
          </Text>
          {item.unreadCount > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.unreadBadge }]}>
              <Text style={styles.badgeText}>
                {item.unreadCount > 99 ? "99+" : item.unreadCount}
              </Text>
            </View>
          ) : null}
        </View>
        {/* Status Lead melekat ke kontak; tampilkan pill untuk SEMUA state
            (termasuk "Belum Tahu" default, dengan warna abu yang lembut). */}
        <View style={styles.labelRow}>
          <View style={[styles.leadPill, { backgroundColor: c + "22" }]}>
            <View style={[styles.labelDot, { backgroundColor: c }]} />
            <Text style={[styles.leadPillText, { color: c }]}>{leadLabel(lead)}</Text>
          </View>
          {item.labels.slice(0, 3).map((l: CustomerLabel) => (
            <View
              key={l.id}
              style={[styles.labelChip, { backgroundColor: l.color + "22" }]}
            >
              <View style={[styles.labelDot, { backgroundColor: l.color }]} />
              <Text style={[styles.labelText, { color: colors.foreground }]}>
                {l.name}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const ChatRow = React.memo(ChatRowBase, (prev, next) => {
  const a = prev.item;
  const b = next.item;
  return (
    prev.colors === next.colors &&
    prev.onPress === next.onPress &&
    a.id === b.id &&
    a.contactName === b.contactName &&
    a.nickname === b.nickname &&
    a.profilePicUrl === b.profilePicUrl &&
    a.lastMessage === b.lastMessage &&
    a.lastMessageAt === b.lastMessageAt &&
    a.unreadCount === b.unreadCount &&
    a.leadStatus === b.leadStatus &&
    labelsKey(a.labels) === labelsKey(b.labels)
  );
});

// Best-match-first ranking for the search box (spec §8): exact name > startsWith
// name > includes name/nickname > includes number > includes message > server
// content match. Lower rank = closer to the top.
function rankOf(c: Chat, q: string): number {
  const contact = c.contactName.toLowerCase();
  const nick = (c.nickname ?? "").toLowerCase();
  const display = (c.nickname || c.contactName).toLowerCase();
  if (contact === q || display === q) return 0;
  if (display.startsWith(q) || contact.startsWith(q)) return 1;
  if (display.includes(q) || contact.includes(q) || nick.includes(q)) return 2;
  if (c.phoneNumber.toLowerCase().includes(q)) return 3;
  if ((c.lastMessage ?? "").toLowerCase().includes(q)) return 4;
  return 5; // matched only via server-side content search
}

export default function ChatListScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { activeChannelId } = useChannel();
  // Deep-link filters from the Dashboard (e.g. tapping "Leads" or a label bar):
  // /(tabs)?filter=leads  or  /(tabs)?label=<labelId>
  const linkParams = useLocalSearchParams<{ filter?: string; label?: string }>();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState<number | null>(null);
  // null = tidak memfilter status lead; selain itu hanya tampilkan kontak
  // dengan status lead tsebut (lead / not_lead / unknown).
  const [leadFilter, setLeadFilter] = useState<ChatLeadStatus | null>(null);
  const [scope, setScope] = useState<"personal" | "group">("personal");

  // Apply incoming deep-link filter params. Keyed on the param values so it
  // fires per navigation (not on a plain tab-bar tap, which carries no params),
  // leaving the user free to change the filter afterwards.
  const filterParam = Array.isArray(linkParams.filter) ? linkParams.filter[0] : linkParams.filter;
  const labelParam = Array.isArray(linkParams.label) ? linkParams.label[0] : linkParams.label;
  useEffect(() => {
    if (filterParam === "leads") {
      setLeadFilter(ChatLeadStatus.lead);
      setLabelFilter(null);
    }
    if (labelParam) {
      const id = Number(labelParam);
      if (Number.isInteger(id)) {
        setLabelFilter(id);
        setLeadFilter(null);
      }
    }
  }, [filterParam, labelParam]);

  // Debounce the search term (~150ms) so we re-rank / fire the content lookup
  // after the user pauses, not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 150);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data: chats,
    isLoading,
    refetch,
  } = useListChats(undefined, {
    query: {
      queryKey: getListChatsQueryKey(),
      enabled: activeChannelId != null,
      // Silent background poll: refresh the cache every 5s but never while the
      // app is backgrounded, and let structural sharing + memoized rows decide
      // what actually re-renders (no full-list flash).
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      placeholderData: keepPreviousData,
    },
  });

  const { data: labels } = useListCustomerLabels();

  // Server-side message-content search: ids of chats whose messages contain the
  // query. Combined with the instant name/phone/nickname filter so the search
  // box also matches words inside conversations (mirrors the web app).
  const { data: contentMatch } = useSearchChatContent(
    { q: debouncedSearch },
    {
      query: {
        queryKey: getSearchChatContentQueryKey({ q: debouncedSearch }),
        enabled: debouncedSearch.length >= 2,
        placeholderData: keepPreviousData,
      },
    },
  );

  const counts = useMemo(() => {
    const all = chats ?? [];
    const group = all.filter(isGroupChat).length;
    return { personal: all.length - group, group };
  }, [chats]);

  const filtered = useMemo(() => {
    let list = chats ?? [];
    list = list.filter((c) => (scope === "group" ? isGroupChat(c) : !isGroupChat(c)));
    if (leadFilter != null) {
      list = list.filter((c) => (c.leadStatus ?? ChatLeadStatus.unknown) === leadFilter);
    }
    if (labelFilter != null) {
      list = list.filter((c) => c.labels.some((l) => l.id === labelFilter));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      const contentIds = new Set(contentMatch?.chatIds ?? []);
      list = list.filter(
        (c) =>
          c.contactName.toLowerCase().includes(q) ||
          c.phoneNumber.toLowerCase().includes(q) ||
          (c.nickname ?? "").toLowerCase().includes(q) ||
          (c.lastMessage ?? "").toLowerCase().includes(q) ||
          contentIds.has(c.id),
      );
      // Rank best matches to the top; Hermes' Array.sort is stable so equal
      // ranks keep their server order (recent-first).
      list = [...list].sort((a, b) => rankOf(a, q) - rankOf(b, q));
    }
    return list;
  }, [chats, labelFilter, leadFilter, search, scope, contentMatch]);

  // Pull-to-refresh spinner is bound to an explicit manual-refresh flag, NOT
  // react-query's `isRefetching` — otherwise the silent 5s background poll would
  // flash the spinner every 5 seconds (spec §10).
  const [manualRefresh, setManualRefresh] = useState(false);
  const onManualRefresh = useCallback(async () => {
    setManualRefresh(true);
    try {
      await refetch();
    } finally {
      setManualRefresh(false);
    }
  }, [refetch]);

  const onPressChat = useCallback(
    (id: number) => router.push(`/chat/${id}`),
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: Chat }) => (
      <ChatRow item={item} colors={colors} onPress={onPressChat} />
    ),
    [colors, onPressChat],
  );

  const keyExtractor = useCallback((c: Chat) => String(c.id), []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 8,
            backgroundColor: colors.header,
          },
        ]}
      >
        <Text style={[styles.headerTitle, { color: colors.headerForeground }]}>
          MaxiChat
        </Text>
        <View style={styles.headerActions}>
          <ChannelSwitcher />
          <TouchableOpacity
            onPress={() => router.push("/(tabs)/status")}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityLabel="Status"
          >
            <Feather name="circle" size={22} color={colors.headerForeground} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.searchWrap, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.searchBox,
            { backgroundColor: colors.secondary, borderColor: colors.border },
          ]}
        >
          <Feather name="search" size={18} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Cari chat"
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </View>

      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {(["personal", "group"] as const).map((s) => {
          const active = scope === s;
          const label = s === "personal" ? "Personal" : "Grup";
          const count = s === "personal" ? counts.personal : counts.group;
          return (
            <TouchableOpacity
              key={s}
              style={styles.tab}
              activeOpacity={0.7}
              onPress={() => setScope(s)}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: active ? colors.primary : colors.mutedForeground },
                ]}
              >
                {label} ({count})
              </Text>
              <View
                style={[
                  styles.tabUnderline,
                  { backgroundColor: active ? colors.primary : "transparent" },
                ]}
              />
            </TouchableOpacity>
          );
        })}
      </View>

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={[
          { id: -2, name: "Leads", color: colors.success } as CustomerLabel,
          { id: -1, name: "Semua", color: colors.primary } as CustomerLabel,
          ...(labels ?? []),
        ]}
        keyExtractor={(l) => String(l.id)}
        style={styles.filterStrip}
        contentContainerStyle={styles.filterContent}
        renderItem={({ item }) => {
          const isLeads = item.id === -2;
          const isAll = item.id === -1;
          if (isLeads) {
            // Pill siklus 3-state: ketuk untuk berpindah Leads → Bukan Leads
            // → Belum Tahu → mati. Warna & teks mengikuti state aktif.
            const on = leadFilter != null;
            const tone = leadFilter != null ? leadColor(leadFilter, colors) : colors.success;
            const cycle = () => {
              setLeadFilter((cur) => {
                if (cur == null) return LEAD_CYCLE[0];
                const i = LEAD_CYCLE.indexOf(cur);
                return i < 0 || i === LEAD_CYCLE.length - 1
                  ? null
                  : LEAD_CYCLE[i + 1];
              });
              setLabelFilter(null);
            };
            return (
              <TouchableOpacity
                style={[
                  styles.filterPill,
                  {
                    backgroundColor: on ? tone : colors.secondary,
                    borderColor: on ? tone : colors.border,
                  },
                ]}
                onPress={cycle}
              >
                <Feather
                  name="user-check"
                  size={13}
                  color={on ? "#ffffff" : colors.success}
                />
                <Text
                  style={[
                    styles.filterText,
                    { color: on ? "#ffffff" : colors.foreground },
                  ]}
                >
                  {leadFilter != null ? leadLabel(leadFilter) : "Leads"}
                </Text>
              </TouchableOpacity>
            );
          }
          const active = isAll ? labelFilter == null : labelFilter === item.id;
          return (
            <TouchableOpacity
              style={[
                styles.filterPill,
                {
                  backgroundColor: active ? colors.primary : colors.secondary,
                  borderColor: active ? colors.primary : colors.border,
                },
              ]}
              onPress={() => setLabelFilter(isAll ? null : item.id)}
            >
              {!isAll ? (
                <View style={[styles.labelDot, { backgroundColor: item.color }]} />
              ) : null}
              <Text
                style={[
                  styles.filterText,
                  {
                    color: active ? colors.primaryForeground : colors.foreground,
                  },
                ]}
              >
                {item.name}
              </Text>
            </TouchableOpacity>
          );
        }}
      />

      {isLoading ? (
        <ChatListSkeleton />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          // Perf tuning for long lists (spec §1): recycle offscreen rows and cap
          // per-frame work so scrolling stays ~60fps on mid-range Android.
          removeClippedSubviews
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          ItemSeparatorComponent={ChatSeparator}
          refreshControl={
            <RefreshControl
              refreshing={manualRefresh}
              onRefresh={onManualRefresh}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather
                name="message-square"
                size={40}
                color={colors.mutedForeground}
              />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {search || labelFilter != null || leadFilter != null
                  ? "Tidak ada chat yang cocok."
                  : "Belum ada chat di channel ini."}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function SeparatorBase() {
  const colors = useColors();
  return <View style={[styles.sep, { backgroundColor: colors.border }]} />;
}
const ChatSeparator = React.memo(SeparatorBase);

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 20 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerBtn: { padding: 4 },
  searchWrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    padding: 0,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 12,
    marginTop: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: "center", paddingTop: 8 },
  tabText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  tabUnderline: {
    height: 3,
    alignSelf: "stretch",
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    marginTop: 8,
  },
  filterStrip: { flexGrow: 0, paddingVertical: 8 },
  filterContent: { paddingHorizontal: 12, gap: 8 },
  filterPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48, gap: 12 },
  emptyText: { fontFamily: "Inter_400Regular", fontSize: 15, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  name: { fontFamily: "Inter_600SemiBold", fontSize: 16, flex: 1, marginRight: 8 },
  time: { fontFamily: "Inter_400Regular", fontSize: 12 },
  rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  preview: { fontFamily: "Inter_400Regular", fontSize: 14, flex: 1, marginRight: 8 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#ffffff", fontFamily: "Inter_600SemiBold", fontSize: 11 },
  labelRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  labelChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  labelDot: { width: 8, height: 8, borderRadius: 4 },
  labelText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  leadPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  leadPillText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 80 },
});
