import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useListShortcuts,
  useSendShortcutToChat,
  getGetChatQueryKey,
  type TextShortcut,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";

export function ShortcutTab({
  chatId,
  onSent,
}: {
  chatId: number;
  onSent: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { data: shortcuts, isLoading } = useListShortcuts();
  const send = useSendShortcutToChat();

  const [query, setQuery] = useState("");
  const [sendingId, setSendingId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = shortcuts ?? [];
    if (!q) return all;
    return all.filter(
      (s) =>
        s.shortcut.toLowerCase().includes(q) ||
        s.replacement.toLowerCase().includes(q),
    );
  }, [shortcuts, query]);

  const onSend = async (s: TextShortcut) => {
    setSendingId(s.id);
    try {
      await send.mutateAsync({ id: chatId, data: { shortcutId: s.id } });
      queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      onSent();
    } catch (e) {
      Alert.alert("Gagal", e instanceof Error ? e.message : "Gagal mengirim");
    } finally {
      setSendingId(null);
    }
  };

  const renderItem = ({ item }: { item: TextShortcut }) => (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.trigger, { color: colors.primary }]}>
          {item.shortcut}
        </Text>
        <Text
          style={[styles.replacement, { color: colors.foreground }]}
          numberOfLines={3}
        >
          {item.replacement}
        </Text>
        {item.link ? (
          <View style={styles.linkRow}>
            <Feather name="image" size={12} color={colors.mutedForeground} />
            <Text
              style={[styles.linkText, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              Dengan gambar
            </Text>
          </View>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={() => onSend(item)}
        disabled={sendingId === item.id}
        style={[styles.sendBtn, { backgroundColor: colors.primary }]}
      >
        {sendingId === item.id ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Feather name="send" size={16} color={colors.primaryForeground} />
        )}
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <View style={[styles.search, { backgroundColor: colors.secondary }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Cari shortcut"
            placeholderTextColor={colors.mutedForeground}
            value={query}
            onChangeText={setQuery}
          />
        </View>
      </View>
      {isLoading ? (
        <ActivityIndicator
          style={{ marginTop: 24 }}
          color={colors.primary}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(s) => String(s.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Tidak ada shortcut.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { padding: 12, paddingBottom: 6 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 15 },
  list: { padding: 12, paddingTop: 6, paddingBottom: 48 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  trigger: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  replacement: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    marginTop: 3,
    lineHeight: 18,
  },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  linkText: { fontFamily: "Inter_400Regular", fontSize: 11 },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
  },
});
