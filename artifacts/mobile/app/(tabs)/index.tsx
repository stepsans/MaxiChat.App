import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

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

export default function ChatListScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { activeChannelId } = useChannel();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState<number | null>(null);
  const [leadOnly, setLeadOnly] = useState(false);
  const [scope, setScope] = useState<"personal" | "group">("personal");

  // Debounce the search term used for the server-side content lookup so we
  // don't fire a request on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data: chats,
    isLoading,
    isRefetching,
    refetch,
  } = useListChats(undefined, {
    query: {
      queryKey: getListChatsQueryKey(),
      enabled: activeChannelId != null,
      refetchInterval: 5000,
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
      },
    },
  );

  const isGroupChat = (c: Chat) => c.phoneNumber.endsWith("@g.us");

  const counts = useMemo(() => {
    const all = chats ?? [];
    const group = all.filter(isGroupChat).length;
    return { personal: all.length - group, group };
  }, [chats]);

  const filtered = useMemo(() => {
    let list = chats ?? [];
    list = list.filter((c) => (scope === "group" ? isGroupChat(c) : !isGroupChat(c)));
    if (leadOnly) {
      list = list.filter((c) => c.leadStatus === ChatLeadStatus.lead);
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
          contentIds.has(c.id),
      );
    }
    return list;
  }, [chats, labelFilter, leadOnly, search, scope, contentMatch]);

  const renderItem = ({ item }: { item: Chat }) => (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.6}
      onPress={() => router.push(`/chat/${item.id}`)}
    >
      <Avatar name={item.contactName} uri={item.profilePicUrl} size={52} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text
            style={[styles.name, { color: colors.foreground }]}
            numberOfLines={1}
          >
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
            <View
              style={[styles.badge, { backgroundColor: colors.unreadBadge }]}
            >
              <Text style={styles.badgeText}>
                {item.unreadCount > 99 ? "99+" : item.unreadCount}
              </Text>
            </View>
          ) : null}
        </View>
        {item.leadStatus === ChatLeadStatus.lead ||
        item.leadStatus === ChatLeadStatus.not_lead ||
        item.labels.length > 0 ? (
          <View style={styles.labelRow}>
            {item.leadStatus === ChatLeadStatus.lead ||
            item.leadStatus === ChatLeadStatus.not_lead ? (
              <View
                style={[
                  styles.leadPill,
                  {
                    backgroundColor:
                      (item.leadStatus === ChatLeadStatus.lead
                        ? colors.success
                        : colors.danger) + "22",
                  },
                ]}
              >
                <View
                  style={[
                    styles.labelDot,
                    {
                      backgroundColor:
                        item.leadStatus === ChatLeadStatus.lead
                          ? colors.success
                          : colors.danger,
                    },
                  ]}
                />
                <Text
                  style={[
                    styles.leadPillText,
                    {
                      color:
                        item.leadStatus === ChatLeadStatus.lead
                          ? colors.success
                          : colors.danger,
                    },
                  ]}
                >
                  {item.leadStatus === ChatLeadStatus.lead ? "Lead" : "Bukan"}
                </Text>
              </View>
            ) : null}
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
        ) : null}
      </View>
    </TouchableOpacity>
  );

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
              return (
                <TouchableOpacity
                  style={[
                    styles.filterPill,
                    {
                      backgroundColor: leadOnly ? colors.success : colors.secondary,
                      borderColor: leadOnly ? colors.success : colors.border,
                    },
                  ]}
                  onPress={() => setLeadOnly((v) => !v)}
                >
                  <Feather
                    name="user-check"
                    size={13}
                    color={leadOnly ? "#ffffff" : colors.success}
                  />
                  <Text
                    style={[
                      styles.filterText,
                      { color: leadOnly ? "#ffffff" : colors.foreground },
                    ]}
                  >
                    Leads
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
                  <View
                    style={[styles.labelDot, { backgroundColor: item.color }]}
                  />
                ) : null}
                <Text
                  style={[
                    styles.filterText,
                    {
                      color: active
                        ? colors.primaryForeground
                        : colors.foreground,
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
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ItemSeparatorComponent={() => (
            <View
              style={[styles.sep, { backgroundColor: colors.border }]}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
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
                {search || labelFilter != null
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
