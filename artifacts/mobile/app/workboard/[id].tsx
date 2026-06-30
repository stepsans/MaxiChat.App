import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

import { useColors } from "@/hooks/useColors";
import { usePermissions } from "@/hooks/usePermissions";
import {
  createWorkboardTask,
  fetchWorkboardBoard,
  moveWorkboardTask,
  type WorkboardBoardDetail,
  type WorkboardColumn,
  type WorkboardTask,
  type WorkboardTaskPriority,
} from "@/lib/workboard";

type Colors = ReturnType<typeof useColors>;

const UNCOLUMNED = -1;
// Long-press duration before a card lifts into drag mode (vertical scroll &
// horizontal paging still work normally below this threshold).
const DRAG_ACTIVATE_MS = 180;
// Horizontal travel (px) required to commit a move to the adjacent column.
const MOVE_THRESHOLD = 90;

const PRIORITIES: { value: WorkboardTaskPriority; label: string }[] = [
  { value: "low", label: "Rendah" },
  { value: "medium", label: "Sedang" },
  { value: "high", label: "Tinggi" },
];

type Lane = { id: number; name: string; color: string | null };

function priorityColor(priority: string, colors: Colors): string {
  if (priority === "high") return colors.danger;
  if (priority === "medium") return colors.warning;
  return colors.success;
}

function priorityLabel(priority: string): string {
  return PRIORITIES.find((p) => p.value === priority)?.label ?? priority;
}

function lift() {
  Haptics.selectionAsync().catch(() => {});
}

// ── Draggable task card ─────────────────────────────────────────────────────
// Long-press lifts the card, then a horizontal drag past the threshold commits
// an optimistic move to the previous/next column. Tap opens the task detail.
// Arrow buttons remain as an explicit, accessible fallback.
function TaskCardBase({
  task,
  laneIndex,
  isFirst,
  isLast,
  canEdit,
  colors,
  onMove,
  onOpen,
}: {
  task: WorkboardTask;
  laneIndex: number;
  isFirst: boolean;
  isLast: boolean;
  canEdit: boolean;
  colors: Colors;
  onMove: (task: WorkboardTask, targetIndex: number) => void;
  onOpen: (task: WorkboardTask) => void;
}) {
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lifted = useSharedValue(0);
  const dir = useSharedValue(0);

  const commit = useCallback(
    (d: number) => onMove(task, laneIndex + d),
    [onMove, task, laneIndex],
  );

  const pan = Gesture.Pan()
    .enabled(canEdit)
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

  const assignees = task.assignees ?? [];

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border, shadowColor: "#000" },
          cardStyle,
        ]}
      >
        {/* Drag-direction hints */}
        <Animated.View style={[styles.hint, styles.hintLeft, { backgroundColor: colors.primary }, leftHint]}>
          <Feather name="arrow-left" size={13} color="#fff" />
          <Text style={styles.hintText}>Pindah</Text>
        </Animated.View>
        <Animated.View style={[styles.hint, styles.hintRight, { backgroundColor: colors.primary }, rightHint]}>
          <Text style={styles.hintText}>Pindah</Text>
          <Feather name="arrow-right" size={13} color="#fff" />
        </Animated.View>

        <TouchableOpacity activeOpacity={0.7} onPress={() => onOpen(task)}>
          <View style={styles.cardTop}>
            <Text style={[styles.cardName, { color: colors.foreground }]} numberOfLines={2}>
              {task.title}
            </Text>
            {task.isCompleted ? (
              <Feather name="check-circle" size={16} color={colors.success} />
            ) : null}
          </View>

          <View style={styles.cardBadges}>
            <View
              style={[styles.priorityPill, { backgroundColor: priorityColor(task.priority, colors) + "22" }]}
            >
              <Text style={[styles.priorityText, { color: priorityColor(task.priority, colors) }]}>
                {priorityLabel(task.priority)}
              </Text>
            </View>
            {task.sourceType === "chat" ? (
              <View style={[styles.tagPill, { borderColor: colors.border }]}>
                <Feather name="message-circle" size={11} color={colors.mutedForeground} />
                <Text style={[styles.tagText, { color: colors.mutedForeground }]}>chat</Text>
              </View>
            ) : null}
            {assignees.length > 0 ? (
              <View style={[styles.tagPill, { borderColor: colors.border }]}>
                <Feather name="user" size={11} color={colors.mutedForeground} />
                <Text style={[styles.tagText, { color: colors.mutedForeground }]}>
                  {assignees.length}
                </Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>

        {canEdit ? (
          <View style={styles.moveRow}>
            <TouchableOpacity
              disabled={isFirst}
              onPress={() => onMove(task, laneIndex - 1)}
              style={[styles.moveBtn, { borderColor: colors.border, opacity: isFirst ? 0.35 : 1 }]}
            >
              <Feather name="arrow-left" size={15} color={colors.foreground} />
            </TouchableOpacity>
            <Feather name="move" size={14} color={colors.mutedForeground} />
            <TouchableOpacity
              disabled={isLast}
              onPress={() => onMove(task, laneIndex + 1)}
              style={[styles.moveBtn, { borderColor: colors.border, opacity: isLast ? 0.35 : 1 }]}
            >
              <Feather name="arrow-right" size={15} color={colors.foreground} />
            </TouchableOpacity>
          </View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

const TaskCard = React.memo(TaskCardBase, (prev, next) => {
  const a = prev.task;
  const b = next.task;
  return (
    prev.colors === next.colors &&
    prev.onMove === next.onMove &&
    prev.onOpen === next.onOpen &&
    prev.laneIndex === next.laneIndex &&
    prev.isFirst === next.isFirst &&
    prev.isLast === next.isLast &&
    prev.canEdit === next.canEdit &&
    a.id === b.id &&
    a.columnId === b.columnId &&
    a.title === b.title &&
    a.priority === b.priority &&
    a.isCompleted === b.isCompleted &&
    (a.assignees?.length ?? 0) === (b.assignees?.length ?? 0)
  );
});

export default function BoardDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const boardId = Number(id);
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const listRef = useRef<FlatList<Lane>>(null);

  const boardKey = useMemo(() => ["workboard", "board", boardId], [boardId]);

  const detailQuery = useQuery({
    queryKey: boardKey,
    queryFn: () => fetchWorkboardBoard(boardId),
    enabled: Number.isInteger(boardId),
  });

  const detail = detailQuery.data;
  const myRole = detail?.myRole ?? null;
  // Board mutations require an editor/owner board role; the matrix "edit" flag
  // gates the menu. Backend re-enforces both, so this only hides controls.
  const canEdit =
    (myRole === "owner" || myRole === "editor") && can("workboard").canEdit;

  const [page, setPage] = useState(0);
  const [detailTask, setDetailTask] = useState<WorkboardTask | null>(null);
  const [addColumnId, setAddColumnId] = useState<number | null | undefined>(undefined);

  const columns = detail?.columns ?? [];
  const tasks = detail?.tasks ?? [];

  // One synthetic "Tanpa kolom" lane at the front when null-column tasks exist —
  // mirrors how the board surfaces uncategorized work; you can drag out of it
  // but not into it (the backend allows null, but the UI keeps it tidy).
  const lanes: Lane[] = useMemo(() => {
    const ls: Lane[] = columns.map((c: WorkboardColumn) => ({
      id: c.id,
      name: c.name,
      color: c.color,
    }));
    const hasUncolumned = tasks.some((t) => t.columnId == null);
    if (hasUncolumned) {
      ls.unshift({ id: UNCOLUMNED, name: "Tanpa kolom", color: null });
    }
    return ls;
  }, [columns, tasks]);

  const byLane = useMemo(() => {
    const map = new Map<number, WorkboardTask[]>();
    const colIds = new Set(columns.map((c) => c.id));
    for (const t of tasks) {
      const key = t.columnId != null && colIds.has(t.columnId) ? t.columnId : UNCOLUMNED;
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [tasks, columns]);

  // Optimistic move: flip the task's column in the cache, roll back on error,
  // reconcile on settle. The web board refetches on focus, so it stays in sync.
  const move = useMutation({
    mutationFn: ({
      task,
      columnId,
      position,
    }: {
      task: WorkboardTask;
      columnId: number;
      position: number;
    }) => moveWorkboardTask(boardId, task.id, columnId, position),
    onMutate: async ({ task, columnId, position }) => {
      await queryClient.cancelQueries({ queryKey: boardKey });
      const prev = queryClient.getQueryData<WorkboardBoardDetail>(boardKey);
      if (prev) {
        queryClient.setQueryData<WorkboardBoardDetail>(boardKey, {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === task.id ? { ...t, columnId, position } : t,
          ),
        });
      }
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      const prev = (ctx as { prev?: WorkboardBoardDetail } | undefined)?.prev;
      if (prev) queryClient.setQueryData(boardKey, prev);
      Alert.alert("Gagal", "Gagal memindahkan task. Coba lagi.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: boardKey });
      queryClient.invalidateQueries({ queryKey: ["workboard", "boards"] });
    },
  });

  const moveTo = useCallback(
    (task: WorkboardTask, laneIndex: number) => {
      const target = lanes[laneIndex];
      // Can't drop into the synthetic "Tanpa kolom" lane or off the edges.
      if (!target || target.id === UNCOLUMNED) return;
      if (task.columnId === target.id) return;
      const targetCount = (byLane.get(target.id) ?? []).length;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      move.mutate({ task, columnId: target.id, position: targetCount });
    },
    [lanes, byLane, move],
  );

  const goTo = (index: number) => {
    if (index < 0 || index >= lanes.length) return;
    listRef.current?.scrollToIndex({ index, animated: true });
    setPage(index);
  };

  const openAdd = (laneId: number) => {
    setAddColumnId(laneId === UNCOLUMNED ? null : laneId);
  };

  const renderLane = useCallback(
    ({ item, index }: { item: Lane; index: number }) => {
      const laneTasks = byLane.get(item.id) ?? [];
      const isFirstReal = index <= 0;
      const isLastReal = index >= lanes.length - 1;
      return (
        <View style={{ width }}>
          <View style={styles.colHeader}>
            <View style={[styles.colDot, { backgroundColor: item.color ?? colors.primary }]} />
            <Text style={[styles.colTitle, { color: colors.foreground }]}>{item.name}</Text>
            <Text style={[styles.colCount, { color: colors.mutedForeground }]}>
              {laneTasks.length}
            </Text>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 96 }}
            showsVerticalScrollIndicator={false}
          >
            {canEdit && item.id !== UNCOLUMNED ? (
              <TouchableOpacity
                onPress={() => openAdd(item.id)}
                style={[styles.addTask, { borderColor: colors.border }]}
              >
                <Feather name="plus" size={16} color={colors.primary} />
                <Text style={[styles.addTaskText, { color: colors.primary }]}>Tambah task</Text>
              </TouchableOpacity>
            ) : null}
            {laneTasks.length > 0 ? (
              laneTasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  laneIndex={index}
                  isFirst={isFirstReal}
                  isLast={isLastReal}
                  canEdit={canEdit}
                  colors={colors}
                  onMove={moveTo}
                  onOpen={setDetailTask}
                />
              ))
            ) : (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                Belum ada task di kolom ini.
              </Text>
            )}
          </ScrollView>
        </View>
      );
    },
    [byLane, lanes.length, width, colors, insets.bottom, moveTo, canEdit],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header with back button */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.header },
        ]}
      >
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Feather name="chevron-left" size={26} color={colors.headerForeground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.headerForeground }]} numberOfLines={1}>
            {detail?.board ? `${detail.board.emoji ? detail.board.emoji + " " : ""}${detail.board.name}` : "WorkBoard"}
          </Text>
          <Text style={[styles.headerSub, { color: colors.headerForeground }]} numberOfLines={1}>
            {detail?.board ? `${detail.board.taskCount} task • ${detail.board.memberCount} anggota` : "Pipeline"}
          </Text>
        </View>
      </View>

      {detailQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : detailQuery.isError ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color={colors.danger} />
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Gagal memuat board.
          </Text>
          <TouchableOpacity
            onPress={() => detailQuery.refetch()}
            style={[styles.retryBtn, { borderColor: colors.border }]}
          >
            <Text style={[styles.retryText, { color: colors.foreground }]}>Coba lagi</Text>
          </TouchableOpacity>
        </View>
      ) : lanes.length === 0 ? (
        <View style={styles.center}>
          <Feather name="columns" size={40} color={colors.mutedForeground} />
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            Board ini belum punya kolom.
          </Text>
        </View>
      ) : (
        <>
          {/* Per-column dot indicators — current column highlighted, tap to jump */}
          <View style={styles.dots}>
            {lanes.map((c, i) => (
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
            data={lanes}
            keyExtractor={(c) => String(c.id)}
            renderItem={renderLane}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) =>
              setPage(Math.round(e.nativeEvent.contentOffset.x / width))
            }
            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          />
        </>
      )}

      {/* Task detail (read view) */}
      <TaskDetailModal
        task={detailTask}
        colors={colors}
        insets={insets}
        onClose={() => setDetailTask(null)}
      />

      {/* Add task */}
      <AddTaskModal
        boardId={boardId}
        columnId={addColumnId}
        visible={addColumnId !== undefined}
        colors={colors}
        insets={insets}
        onClose={() => setAddColumnId(undefined)}
        onCreated={() => {
          setAddColumnId(undefined);
          queryClient.invalidateQueries({ queryKey: boardKey });
          queryClient.invalidateQueries({ queryKey: ["workboard", "boards"] });
        }}
      />
    </View>
  );
}

// ── Task detail (read-only) ─────────────────────────────────────────────────
function TaskDetailModal({
  task,
  colors,
  insets,
  onClose,
}: {
  task: WorkboardTask | null;
  colors: Colors;
  insets: ReturnType<typeof useSafeAreaInsets>;
  onClose: () => void;
}) {
  return (
    <Modal visible={task != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Detail Task</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          {task ? (
            <ScrollView contentContainerStyle={{ paddingVertical: 12, gap: 14 }}>
              <Text style={[styles.detailTitle, { color: colors.foreground }]}>{task.title}</Text>
              <View style={styles.cardBadges}>
                <View
                  style={[styles.priorityPill, { backgroundColor: priorityColor(task.priority, colors) + "22" }]}
                >
                  <Text style={[styles.priorityText, { color: priorityColor(task.priority, colors) }]}>
                    Prioritas {priorityLabel(task.priority)}
                  </Text>
                </View>
                {task.isCompleted ? (
                  <View style={[styles.tagPill, { borderColor: colors.success }]}>
                    <Feather name="check-circle" size={12} color={colors.success} />
                    <Text style={[styles.tagText, { color: colors.success }]}>Selesai</Text>
                  </View>
                ) : null}
              </View>
              {task.description ? (
                <View>
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Deskripsi</Text>
                  <Text style={[styles.detailBody, { color: colors.foreground }]}>{task.description}</Text>
                </View>
              ) : null}
              {task.assignees && task.assignees.length > 0 ? (
                <View>
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Ditugaskan ke</Text>
                  <Text style={[styles.detailBody, { color: colors.foreground }]}>
                    {task.assignees.map((a) => a.name || a.email || "—").join(", ")}
                  </Text>
                </View>
              ) : null}
              {task.sourceType === "chat" && task.sourceContactName ? (
                <View>
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Dari chat</Text>
                  <Text style={[styles.detailBody, { color: colors.foreground }]}>
                    {task.sourceContactName}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.detailHint, { color: colors.mutedForeground }]}>
                Edit detail task lengkap tersedia di versi web.
              </Text>
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Add task ────────────────────────────────────────────────────────────────
function AddTaskModal({
  boardId,
  columnId,
  visible,
  colors,
  insets,
  onClose,
  onCreated,
}: {
  boardId: number;
  columnId: number | null | undefined;
  visible: boolean;
  colors: Colors;
  insets: ReturnType<typeof useSafeAreaInsets>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkboardTaskPriority>("medium");

  // Reset fields each time the sheet opens.
  React.useEffect(() => {
    if (visible) {
      setTitle("");
      setDescription("");
      setPriority("medium");
    }
  }, [visible]);

  const createMutation = useMutation({
    mutationFn: () =>
      createWorkboardTask(boardId, {
        title: title.trim(),
        description: description.trim() || undefined,
        columnId: columnId ?? null,
        priority,
      }),
    onSuccess: onCreated,
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Gagal membuat task. Coba lagi.";
      Alert.alert("Gagal", msg);
    },
  });

  const canSave = title.trim().length > 0 && !createMutation.isPending;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Tambah Task</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingVertical: 8 }} keyboardShouldPersistTaps="handled">
            <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Judul</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.secondary, color: colors.foreground }]}
              value={title}
              onChangeText={setTitle}
              placeholder="Judul task"
              placeholderTextColor={colors.mutedForeground}
              autoFocus
            />
            <Text style={[styles.detailLabel, { color: colors.mutedForeground, marginTop: 14 }]}>
              Deskripsi
            </Text>
            <TextInput
              style={[
                styles.input,
                styles.textarea,
                { backgroundColor: colors.secondary, color: colors.foreground },
              ]}
              value={description}
              onChangeText={setDescription}
              placeholder="Deskripsi task (opsional)"
              placeholderTextColor={colors.mutedForeground}
              multiline
            />
            <Text style={[styles.detailLabel, { color: colors.mutedForeground, marginTop: 14 }]}>
              Prioritas
            </Text>
            <View style={styles.chipWrap}>
              {PRIORITIES.map((p) => {
                const active = priority === p.value;
                return (
                  <TouchableOpacity
                    key={p.value}
                    onPress={() => setPriority(p.value)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: active ? colors.primary : colors.secondary,
                        borderColor: active ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: active ? colors.primaryForeground : colors.foreground },
                      ]}
                    >
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <TouchableOpacity
            onPress={() => createMutation.mutate()}
            disabled={!canSave}
            style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: canSave ? 1 : 0.5 }]}
          >
            {createMutation.isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>Simpan</Text>
            )}
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  header: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  backBtn: { padding: 2 },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 18 },
  headerSub: { fontFamily: "Inter_400Regular", fontSize: 12, opacity: 0.85, marginTop: 1 },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    flexWrap: "wrap",
    paddingHorizontal: 16,
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
  addTask: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    marginBottom: 10,
  },
  addTaskText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 10,
    gap: 8,
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
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  cardName: { flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 15, lineHeight: 20 },
  cardBadges: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6 },
  priorityPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  priorityText: { fontFamily: "Inter_600SemiBold", fontSize: 11 },
  tagPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagText: { fontFamily: "Inter_500Medium", fontSize: 11 },
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
    paddingVertical: 24,
    lineHeight: 20,
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  // Modals
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "88%",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 17 },
  closeBtn: { padding: 4 },
  detailTitle: { fontFamily: "Inter_700Bold", fontSize: 19, lineHeight: 26 },
  detailLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  detailBody: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 21 },
  detailHint: { fontFamily: "Inter_400Regular", fontSize: 12, fontStyle: "italic", marginTop: 4 },
  input: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  textarea: { minHeight: 96, textAlignVertical: "top" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  saveBtn: { borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  saveBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
});
