import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ChatWithMessages } from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import {
  createWorkboardTask,
  fetchWorkboardBoard,
  fetchWorkboardBoards,
  type WorkboardTaskPriority,
} from "@/lib/workboard";

const PRIORITIES: { value: WorkboardTaskPriority; label: string }[] = [
  { value: "low", label: "Rendah" },
  { value: "medium", label: "Sedang" },
  { value: "high", label: "Tinggi" },
];

// Display name resolved the same way the chat list/header does it.
function displayName(chat: ChatWithMessages): string {
  return chat.nickname?.trim() || chat.contactName || chat.phoneNumber;
}

// Pre-fill description from chat context (no extra endpoint): the last up to 3
// non-empty messages (newest last), then a footer linking back to the chat.
function buildDescription(chat: ChatWithMessages): string {
  const phone = chat.phoneNumber.split("@")[0];
  const recent = (chat.messages ?? [])
    .filter((m) => m.content && m.content.trim().length > 0)
    .slice(-3)
    .map((m) => m.content.trim());
  const body = recent.length > 0 ? recent.join("\n") : chat.lastMessage ?? "";
  const footer = `—\nDari chat: ${displayName(chat)} (${phone})`;
  return body ? `${body}\n\n${footer}` : footer;
}

// `undefined` = no column chosen yet (auto-pick first); `null` = "Tanpa kolom".
type ColumnChoice = number | null | undefined;

export function AddToWorkboardSheet({
  visible,
  onClose,
  chat,
}: {
  visible: boolean;
  onClose: () => void;
  chat: ChatWithMessages | undefined;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [boardId, setBoardId] = useState<number | null>(null);
  const [columnId, setColumnId] = useState<ColumnChoice>(undefined);
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkboardTaskPriority>("medium");

  const boardsQuery = useQuery({
    queryKey: ["workboard", "boards"],
    queryFn: fetchWorkboardBoards,
    enabled: visible,
  });

  const detailQuery = useQuery({
    queryKey: ["workboard", "board", boardId],
    queryFn: () => fetchWorkboardBoard(boardId as number),
    enabled: visible && boardId != null,
  });
  const columns = detailQuery.data?.columns ?? [];
  const members = detailQuery.data?.members ?? [];

  const toggleAssignee = (userId: number) =>
    setAssigneeIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );

  // Re-seed title/description from the chat each time the sheet opens.
  useEffect(() => {
    if (visible && chat) {
      setTitle(displayName(chat));
      setDescription(buildDescription(chat));
      setBoardId(null);
      setColumnId(undefined);
      setAssigneeIds([]);
      setPriority("medium");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, chat?.id]);

  // Default-select the first column (lowest position) once a board loads, unless
  // the user has explicitly chosen a column (including "Tanpa kolom" → null).
  useEffect(() => {
    if (columns.length > 0 && columnId === undefined) {
      setColumnId(columns[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, detailQuery.data]);

  const createMutation = useMutation({
    mutationFn: () =>
      createWorkboardTask(boardId as number, {
        title: title.trim(),
        description: description.trim() || undefined,
        columnId: columnId === undefined ? null : columnId,
        priority,
        assigneeIds: assigneeIds.length > 0 ? assigneeIds : undefined,
        tags: "from-chat",
        sourceType: "chat",
        sourceChatId: chat?.id,
      }),
    onSuccess: () => {
      const boardName =
        boardsQuery.data?.find((b) => b.id === boardId)?.name ?? "WorkBoard";
      onClose();
      Alert.alert("Berhasil", `Task dibuat di ${boardName}`);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Gagal membuat task. Coba lagi.";
      Alert.alert("Gagal", msg);
    },
  });

  const canSave =
    boardId != null && title.trim().length > 0 && !createMutation.isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 },
          ]}
        >
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Tambah ke WorkBoard
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── 1. Pilih Board ───────────────────────────────────────────── */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Pilih Board
            </Text>
            {boardsQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 20 }} />
            ) : boardsQuery.isError ? (
              <Text style={[styles.empty, { color: colors.danger }]}>
                Gagal memuat board. Coba lagi.
              </Text>
            ) : (boardsQuery.data ?? []).length === 0 ? (
              <View style={[styles.emptyBox, { borderColor: colors.border }]}>
                <Feather name="layout" size={28} color={colors.mutedForeground} />
                <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                  Belum ada board. Buat board terlebih dahulu di dashboard
                  WorkBoard.
                </Text>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {(boardsQuery.data ?? []).map((b) => {
                  const active = boardId === b.id;
                  return (
                    <TouchableOpacity
                      key={b.id}
                      onPress={() => {
                        setBoardId(b.id);
                        setColumnId(undefined);
                        setAssigneeIds([]);
                      }}
                      style={[
                        styles.boardRow,
                        {
                          backgroundColor: active ? colors.primarySoft : colors.secondary,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text style={styles.boardEmoji}>{b.emoji || "📋"}</Text>
                      <Text
                        style={[styles.boardName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {b.name}
                      </Text>
                      <Text style={[styles.boardCount, { color: colors.mutedForeground }]}>
                        {b.taskCount} task
                      </Text>
                      {active ? (
                        <Feather name="check-circle" size={18} color={colors.primary} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* ── 2. Pilih Kolom ───────────────────────────────────────────── */}
            {boardId != null ? (
              <>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                  Pilih Kolom
                </Text>
                {detailQuery.isLoading ? (
                  <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
                ) : (
                  <View style={styles.chipWrap}>
                    {columns.map((c) => {
                      const active = columnId === c.id;
                      return (
                        <TouchableOpacity
                          key={c.id}
                          onPress={() => setColumnId(c.id)}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: active ? colors.primary : colors.secondary,
                              borderColor: active ? colors.primary : colors.border,
                            },
                          ]}
                        >
                          {c.color ? (
                            <View style={[styles.dot, { backgroundColor: c.color }]} />
                          ) : null}
                          <Text
                            style={[
                              styles.chipText,
                              { color: active ? colors.primaryForeground : colors.foreground },
                            ]}
                          >
                            {c.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                    {/* Tanpa kolom → columnId: null */}
                    <TouchableOpacity
                      onPress={() => setColumnId(null)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: columnId === null ? colors.primary : colors.secondary,
                          borderColor: columnId === null ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          {
                            color:
                              columnId === null ? colors.primaryForeground : colors.foreground,
                          },
                        ]}
                      >
                        Tanpa kolom
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* ── Tag staf (assignee) ────────────────────────────────── */}
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                  Tag Staf
                </Text>
                {detailQuery.isLoading ? (
                  <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />
                ) : members.length === 0 ? (
                  <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                    Tidak ada anggota di board ini.
                  </Text>
                ) : (
                  <View style={styles.chipWrap}>
                    {members.map((m) => {
                      const active = assigneeIds.includes(m.userId);
                      const label = m.name || m.email || "?";
                      return (
                        <TouchableOpacity
                          key={m.userId}
                          onPress={() => toggleAssignee(m.userId)}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: active ? colors.primary : colors.secondary,
                              borderColor: active ? colors.primary : colors.border,
                            },
                          ]}
                        >
                          <View
                            style={[
                              styles.avatar,
                              {
                                backgroundColor: active
                                  ? colors.primaryForeground + "33"
                                  : colors.border,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.avatarText,
                                { color: active ? colors.primaryForeground : colors.foreground },
                              ]}
                            >
                              {label.slice(0, 1).toUpperCase()}
                            </Text>
                          </View>
                          <Text
                            style={[
                              styles.chipText,
                              { color: active ? colors.primaryForeground : colors.foreground },
                            ]}
                            numberOfLines={1}
                          >
                            {label}
                          </Text>
                          {active ? (
                            <Feather name="check" size={13} color={colors.primaryForeground} />
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </>
            ) : null}

            {/* ── 3. Detail Task ───────────────────────────────────────────── */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Judul
            </Text>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: colors.secondary, color: colors.foreground },
              ]}
              value={title}
              onChangeText={setTitle}
              placeholder="Judul task"
              placeholderTextColor={colors.mutedForeground}
            />

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
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
              placeholder="Deskripsi task"
              placeholderTextColor={colors.mutedForeground}
              multiline
            />

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
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

          {/* Save */}
          <TouchableOpacity
            onPress={() => createMutation.mutate()}
            disabled={!canSave}
            style={[
              styles.saveBtn,
              { backgroundColor: colors.primary, opacity: canSave ? 1 : 0.5 },
            ]}
          >
            {createMutation.isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
                Simpan
              </Text>
            )}
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "88%",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 17 },
  closeBtn: { padding: 4 },
  body: { paddingBottom: 16 },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  empty: { fontFamily: "Inter_400Regular", fontSize: 14, textAlign: "center" },
  emptyBox: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 24,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
  },
  boardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  boardEmoji: { fontSize: 18 },
  boardName: { flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  boardCount: { fontFamily: "Inter_400Regular", fontSize: 12 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontFamily: "Inter_500Medium", fontSize: 13, maxWidth: 140 },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: "Inter_600SemiBold", fontSize: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  input: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  textarea: { minHeight: 96, textAlignVertical: "top" },
  saveBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  saveBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
});
