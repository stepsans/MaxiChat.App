import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
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
import { WorkboardSkeleton } from "@/components/Skeleton";
import { formatRupiah } from "@/components/chat-info/shared";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

type Colors = ReturnType<typeof useColors>;

const UNSTAGED = -1;
// Long-press duration before a card lifts into drag mode (vertical scroll &
// horizontal paging still work normally below this threshold).
const DRAG_ACTIVATE_MS = 180;
// Horizontal travel (px) required to commit a move to the adjacent stage.
const MOVE_THRESHOLD = 90;

type Column = { id: number; name: string; color: string | null };

function scoreColor(score: number, colors: Colors): string {
  if (score >= 70) return colors.success;
  if (score >= 40) return colors.warning;
  return colors.mutedForeground;
}

function lift() {
  Haptics.selectionAsync().catch(() => {});
}

// ── Draggable card ────────────────────────────────────────────────────────────
// Long-press lifts the card (scale + shadow on the UI thread), then a horizontal
// drag past the threshold commits an optimistic move to the previous/next stage.
// Arrow buttons remain as an explicit, accessible fallback — both paths call the
// same optimistic `onMove`.
function DraggableCardBase({
  opp,
  colIndex,
  isFirst,
  isLast,
  colors,
  onMove,
}: {
  opp: Opportunity;
  colIndex: number;
  isFirst: boolean;
  isLast: boolean;
  colors: Colors;
  onMove: (opp: Opportunity, targetIndex: number) => void;
}) {
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lifted = useSharedValue(0); // 0 = resting, 1 = picked up
  const dir = useSharedValue(0); // -1 = will move left, 1 = right, 0 = none

  const commit = useCallback(
    (d: number) => onMove(opp, colIndex + d),
    [onMove, opp, colIndex],
  );

  const pan = Gesture.Pan()
    .activateAfterLongPress(DRAG_ACTIVATE_MS)
    .onStart(() => {
      lifted.value = withSpring(1, { damping: 18, stiffness: 220 });
      runOnJS(lift)();
    })
    .onUpdate((e) => {
      tx.value = e.translationX;
      ty.value = e.translationY;
      if (e.translationX <= -MOVE_THRESHOLD && !isFirst) dir.value = -1;
      else if (e.translationX >= MOVE_THRESHOLD && !isLast) dir.value = 1;
      else dir.value = 0;
    })
    .onEnd((e) => {
      if (e.translationX <= -MOVE_THRESHOLD && !isFirst) runOnJS(commit)(-1);
      else if (e.translationX >= MOVE_THRESHOLD && !isLast) runOnJS(commit)(1);
      tx.value = withSpring(0);
      ty.value = withSpring(0);
      lifted.value = withSpring(0);
      dir.value = 0;
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: 1 + lifted.value * 0.04 },
    ],
    zIndex: lifted.value > 0 ? 20 : 0,
    elevation: lifted.value * 8,
    shadowOpacity: lifted.value * 0.22,
    opacity: 1 - lifted.value * 0.04,
  }));
  const leftHint = useAnimatedStyle(() => ({ opacity: dir.value === -1 ? 1 : 0 }));
  const rightHint = useAnimatedStyle(() => ({ opacity: dir.value === 1 ? 1 : 0 }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border, shadowColor: "#000" },
          cardStyle,
        ]}
      >
        {/* Drag-direction hints (fade in while dragging past the threshold) */}
        <Animated.View style={[styles.hint, styles.hintLeft, { backgroundColor: colors.primary }, leftHint]}>
          <Feather name="arrow-left" size={13} color="#fff" />
          <Text style={styles.hintText}>Pindah</Text>
        </Animated.View>
        <Animated.View style={[styles.hint, styles.hintRight, { backgroundColor: colors.primary }, rightHint]}>
          <Text style={styles.hintText}>Pindah</Text>
          <Feather name="arrow-right" size={13} color="#fff" />
        </Animated.View>

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
            disabled={isFirst}
            onPress={() => onMove(opp, colIndex - 1)}
            style={[styles.moveBtn, { borderColor: colors.border, opacity: isFirst ? 0.35 : 1 }]}
          >
            <Feather name="arrow-left" size={15} color={colors.foreground} />
          </TouchableOpacity>
          <Feather name="move" size={14} color={colors.mutedForeground} />
          <TouchableOpacity
            disabled={isLast}
            onPress={() => onMove(opp, colIndex + 1)}
            style={[styles.moveBtn, { borderColor: colors.border, opacity: isLast ? 0.35 : 1 }]}
          >
            <Feather name="arrow-right" size={15} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const DraggableCard = React.memo(DraggableCardBase, (prev, next) => {
  const a = prev.opp;
  const b = next.opp;
  return (
    prev.colors === next.colors &&
    prev.onMove === next.onMove &&
    prev.colIndex === next.colIndex &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    a.id === b.id &&
    a.stageId === b.stageId &&
    a.contactName === b.contactName &&
    a.contactPhone === b.contactPhone &&
    a.leadScore === b.leadScore &&
    a.estimatedValueIdr === b.estimatedValueIdr &&
    (a.productInterest ?? []).join() === (b.productInterest ?? []).join()
  );
});

export default function WorkboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { activeChannelId } = useChannel();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Column>>(null);
  const oppsKey = useMemo(() => getListOpportunitiesQueryKey(), []);

  const enabled = activeChannelId != null;
  const { data: stages, isLoading: stagesLoading } = useListSalesStages(undefined, {
    query: { queryKey: getListSalesStagesQueryKey(), enabled },
  });
  const { data: opportunities, isLoading: oppsLoading } = useListOpportunities(undefined, {
    query: {
      queryKey: oppsKey,
      enabled,
      refetchInterval: 15000,
      refetchIntervalInBackground: false,
    },
  });

  // Optimistic move: flip the card's stage in the cache instantly, roll back on
  // error, and reconcile with the server on settle.
  const update = useUpdateOpportunity({
    mutation: {
      onMutate: async ({ id, data }) => {
        await queryClient.cancelQueries({ queryKey: oppsKey });
        const prev = queryClient.getQueryData<Opportunity[]>(oppsKey);
        if (prev && data.stageId != null) {
          queryClient.setQueryData<Opportunity[]>(
            oppsKey,
            prev.map((o) => (o.id === id ? { ...o, stageId: data.stageId! } : o)),
          );
        }
        return { prev };
      },
      onError: (_e, _vars, ctx) => {
        const prev = (ctx as { prev?: Opportunity[] } | undefined)?.prev;
        if (prev) queryClient.setQueryData(oppsKey, prev);
        Alert.alert("Gagal", "Gagal memindahkan kartu. Coba lagi.");
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: oppsKey });
      },
    },
  });

  const [page, setPage] = useState(0);

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

  const moveTo = useCallback(
    (opp: Opportunity, columnIndex: number) => {
      const target = columns[columnIndex];
      // Can't drop into the synthetic "Belum diatur" lane or off the edges.
      if (!target || target.id === UNSTAGED) return;
      if (opp.stageId === target.id) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      update.mutate({ id: opp.id, data: { stageId: target.id } });
    },
    [columns, update.mutate],
  );

  const goTo = (index: number) => {
    if (index < 0 || index >= columns.length) return;
    listRef.current?.scrollToIndex({ index, animated: true });
    setPage(index);
  };

  const renderColumn = useCallback(
    ({ item, index }: { item: Column; index: number }) => {
      const opps = byColumn.get(item.id) ?? [];
      const isFirstReal = index <= 0;
      const isLastReal = index >= columns.length - 1;
      return (
        <View style={{ width }}>
          <View style={styles.colHeader}>
            <View style={[styles.colDot, { backgroundColor: item.color ?? colors.primary }]} />
            <Text style={[styles.colTitle, { color: colors.foreground }]}>{item.name}</Text>
            <Text style={[styles.colCount, { color: colors.mutedForeground }]}>{opps.length}</Text>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 24 }}
            showsVerticalScrollIndicator={false}
          >
            {opps.length > 0 ? (
              opps.map((o) => (
                <DraggableCard
                  key={o.id}
                  opp={o}
                  colIndex={index}
                  isFirst={isFirstReal}
                  isLast={isLastReal}
                  colors={colors}
                  onMove={moveTo}
                />
              ))
            ) : (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                Belum ada opportunity di stage ini.
              </Text>
            )}
          </ScrollView>
        </View>
      );
    },
    [byColumn, columns.length, width, colors, insets.bottom, moveTo],
  );

  const loading = stagesLoading || oppsLoading;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Workboard" subtitle="Pipeline sales" />

      {loading ? (
        <WorkboardSkeleton />
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
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
  },
  hint: {
    position: "absolute",
    top: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    zIndex: 5,
  },
  hintLeft: { left: 10 },
  hintRight: { right: 10 },
  hintText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 11 },
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
