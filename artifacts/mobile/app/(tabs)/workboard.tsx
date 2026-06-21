import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useListOpportunities,
  useListSalesStages,
  useUpdateOpportunity,
  getListOpportunitiesQueryKey,
  getListSalesStagesQueryKey,
  type Opportunity,
  type SalesStage,
} from "@workspace/api-client-react";

import { ScreenHeader } from "@/components/ScreenHeader";
import { formatRupiah } from "@/components/chat-info/shared";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

const UNSTAGED = -1;

type Column = { id: number; name: string; color: string | null };

export default function WorkboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { activeChannelId } = useChannel();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Column>>(null);

  const enabled = activeChannelId != null;
  const { data: stages, isLoading: stagesLoading } = useListSalesStages(undefined, {
    query: { queryKey: getListSalesStagesQueryKey(), enabled },
  });
  const {
    data: opportunities,
    isLoading: oppsLoading,
  } = useListOpportunities(undefined, {
    query: {
      queryKey: getListOpportunitiesQueryKey(),
      enabled,
      refetchInterval: 15000,
    },
  });
  const update = useUpdateOpportunity();

  const [page, setPage] = useState(0);
  const [movingId, setMovingId] = useState<number | null>(null);

  const sortedStages = useMemo(
    () => [...(stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [stages],
  );

  const columns: Column[] = useMemo(() => {
    const cols: Column[] = sortedStages.map((s: SalesStage) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    }));
    const stageIds = new Set(sortedStages.map((s) => s.id));
    const hasUnstaged = (opportunities ?? []).some(
      (o) => o.stageId == null || !stageIds.has(o.stageId),
    );
    if (hasUnstaged) {
      cols.unshift({ id: UNSTAGED, name: "Belum diatur", color: null });
    }
    return cols;
  }, [sortedStages, opportunities]);

  const byColumn = useMemo(() => {
    const map = new Map<number, Opportunity[]>();
    const stageIds = new Set(sortedStages.map((s) => s.id));
    for (const o of opportunities ?? []) {
      const key = o.stageId != null && stageIds.has(o.stageId) ? o.stageId : UNSTAGED;
      const arr = map.get(key) ?? [];
      arr.push(o);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.leadScore - a.leadScore);
    return map;
  }, [opportunities, sortedStages]);

  const moveTo = async (opp: Opportunity, columnIndex: number) => {
    const target = columns[columnIndex];
    if (!target || target.id === UNSTAGED) return;
    setMovingId(opp.id);
    try {
      await update.mutateAsync({ id: opp.id, data: { stageId: target.id } });
      queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });
    } catch (e) {
      Alert.alert("Gagal", e instanceof Error ? e.message : "Gagal memindahkan");
    } finally {
      setMovingId(null);
    }
  };

  const goTo = (index: number) => {
    if (index < 0 || index >= columns.length) return;
    listRef.current?.scrollToIndex({ index, animated: true });
    setPage(index);
  };

  const renderCard = (opp: Opportunity, colIndex: number) => {
    const moving = movingId === opp.id;
    return (
      <View
        key={opp.id}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.cardTop}>
          <Text style={[styles.cardName, { color: colors.foreground }]} numberOfLines={1}>
            {opp.contactName || opp.contactPhone}
          </Text>
          <View style={[styles.scorePill, { backgroundColor: scoreColor(opp.leadScore, colors) + "22" }]}>
            <Text style={[styles.scoreText, { color: scoreColor(opp.leadScore, colors) }]}>
              {opp.leadScore}
            </Text>
          </View>
        </View>
        {opp.estimatedValueIdr > 0 ? (
          <Text style={[styles.cardValue, { color: colors.success }]}>
            {formatRupiah(opp.estimatedValueIdr)}
          </Text>
        ) : null}
        {opp.productInterest && opp.productInterest.length > 0 ? (
          <Text style={[styles.cardProducts, { color: colors.mutedForeground }]} numberOfLines={1}>
            {opp.productInterest.join(", ")}
          </Text>
        ) : null}
        <View style={styles.moveRow}>
          <TouchableOpacity
            disabled={colIndex <= 0 || moving}
            onPress={() => moveTo(opp, colIndex - 1)}
            style={[
              styles.moveBtn,
              { borderColor: colors.border, opacity: colIndex <= 0 ? 0.35 : 1 },
            ]}
          >
            <Feather name="arrow-left" size={15} color={colors.foreground} />
          </TouchableOpacity>
          {moving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="move" size={14} color={colors.mutedForeground} />
          )}
          <TouchableOpacity
            disabled={colIndex >= columns.length - 1 || moving}
            onPress={() => moveTo(opp, colIndex + 1)}
            style={[
              styles.moveBtn,
              { borderColor: colors.border, opacity: colIndex >= columns.length - 1 ? 0.35 : 1 },
            ]}
          >
            <Feather name="arrow-right" size={15} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderColumn = ({ item, index }: { item: Column; index: number }) => {
    const opps = byColumn.get(item.id) ?? [];
    return (
      <View style={{ width }}>
        <View style={styles.colHeader}>
          <View
            style={[
              styles.colDot,
              { backgroundColor: item.color ?? colors.primary },
            ]}
          />
          <Text style={[styles.colTitle, { color: colors.foreground }]}>{item.name}</Text>
          <Text style={[styles.colCount, { color: colors.mutedForeground }]}>
            {opps.length}
          </Text>
        </View>
        <ScrollView
          contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
        >
          {opps.length > 0 ? (
            opps.map((o) => renderCard(o, index))
          ) : (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Belum ada opportunity di stage ini.
            </Text>
          )}
        </ScrollView>
      </View>
    );
  };

  const loading = stagesLoading || oppsLoading;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Workboard" subtitle="Pipeline sales" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : columns.length === 0 ? (
        <View style={styles.center}>
          <Feather name="columns" size={40} color={colors.mutedForeground} />
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Belum ada stage pipeline.
          </Text>
        </View>
      ) : (
        <>
          {/* Per-stage dot indicators — current stage highlighted, tap to jump */}
          <View style={styles.dots}>
            {columns.map((c, i) => (
              <TouchableOpacity
                key={c.id}
                onPress={() => goTo(i)}
                hitSlop={6}
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === page ? colors.primary : colors.border,
                    width: i === page ? 22 : 8,
                  },
                ]}
              />
            ))}
          </View>
          <FlatList
            ref={listRef}
            data={columns}
            keyExtractor={(c) => String(c.id)}
            renderItem={renderColumn}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) =>
              setPage(Math.round(e.nativeEvent.contentOffset.x / width))
            }
            getItemLayout={(_, index) => ({
              length: width,
              offset: width * index,
              index,
            })}
          />
        </>
      )}
    </View>
  );
}

function scoreColor(score: number, colors: ReturnType<typeof useColors>): string {
  if (score >= 70) return colors.success;
  if (score >= 40) return colors.warning;
  return colors.mutedForeground;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
  },
  dot: { height: 8, borderRadius: 4 },
  colHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  colDot: { width: 10, height: 10, borderRadius: 5 },
  colTitle: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 16 },
  colCount: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardName: { flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  scorePill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  scoreText: { fontFamily: "Inter_700Bold", fontSize: 12 },
  cardValue: { fontFamily: "Inter_700Bold", fontSize: 14 },
  cardProducts: { fontFamily: "Inter_400Regular", fontSize: 12 },
  moveRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  moveBtn: {
    width: 40,
    height: 30,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
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
