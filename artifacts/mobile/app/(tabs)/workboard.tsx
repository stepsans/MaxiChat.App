import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { WorkboardSkeleton } from "@/components/Skeleton";
import { useColors } from "@/hooks/useColors";
import { usePermissions } from "@/hooks/usePermissions";
import { fetchWorkboardBoards, type WorkboardBoard } from "@/lib/workboard";

export default function WorkboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { can, isLoading: permLoading } = usePermissions();
  const canView = can("workboard").canView;

  const boardsQuery = useQuery({
    queryKey: ["workboard", "boards"],
    queryFn: fetchWorkboardBoards,
    enabled: canView,
  });

  // Refresh the board list whenever the tab regains focus (e.g. returning from a
  // board detail where a task was added) so counts/boards stay in sync.
  useFocusEffect(
    useCallback(() => {
      if (canView) boardsQuery.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canView]),
  );

  const renderBoard = useCallback(
    ({ item }: { item: WorkboardBoard }) => {
      const accent = item.color || colors.primary;
      return (
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => router.push(`/workboard/${item.id}`)}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <View style={[styles.accent, { backgroundColor: accent }]} />
          <View style={styles.cardBody}>
            <View style={styles.cardTop}>
              <Text style={styles.cardEmoji}>{item.emoji || "📋"}</Text>
              <Text
                style={[styles.cardName, { color: colors.foreground }]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </View>
            {item.description ? (
              <Text
                style={[styles.cardDesc, { color: colors.mutedForeground }]}
                numberOfLines={2}
              >
                {item.description}
              </Text>
            ) : null}
            <View style={styles.cardMeta}>
              <View style={styles.metaItem}>
                <Feather name="check-square" size={13} color={colors.mutedForeground} />
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                  {item.taskCount} task
                </Text>
              </View>
              <View style={styles.metaItem}>
                <Feather name="users" size={13} color={colors.mutedForeground} />
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                  {item.memberCount} anggota
                </Text>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      );
    },
    [colors, router],
  );

  const loading = permLoading || (canView && boardsQuery.isLoading);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Workboard" subtitle="Kelola pekerjaan tim" />

      {!permLoading && !canView ? (
        <View style={styles.center}>
          <Feather name="lock" size={40} color={colors.mutedForeground} />
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Kamu tidak punya akses ke WorkBoard.
          </Text>
        </View>
      ) : loading ? (
        <WorkboardSkeleton />
      ) : boardsQuery.isError ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color={colors.danger} />
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Gagal memuat board. Tarik untuk coba lagi.
          </Text>
          <TouchableOpacity
            onPress={() => boardsQuery.refetch()}
            style={[styles.retryBtn, { borderColor: colors.border }]}
          >
            <Text style={[styles.retryText, { color: colors.foreground }]}>Coba lagi</Text>
          </TouchableOpacity>
        </View>
      ) : (boardsQuery.data ?? []).length === 0 ? (
        <View style={styles.center}>
          <Feather name="layout" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Belum ada board
          </Text>
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Buat board di versi web untuk mulai mengorganisir pekerjaan tim.
          </Text>
        </View>
      ) : (
        <FlatList
          data={boardsQuery.data ?? []}
          keyExtractor={(b) => String(b.id)}
          renderItem={renderBoard}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={boardsQuery.isRefetching}
              onRefresh={() => boardsQuery.refetch()}
              tintColor={colors.primary}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  card: {
    flexDirection: "row",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  accent: { width: 5 },
  cardBody: { flex: 1, padding: 14, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardEmoji: { fontSize: 20 },
  cardName: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 16 },
  cardDesc: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 18 },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 2 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  metaText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 17 },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
