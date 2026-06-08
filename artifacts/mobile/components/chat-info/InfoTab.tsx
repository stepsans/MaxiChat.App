import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useGetCommonGroups,
  useListCustomerLabels,
  useSetChatLabels,
  useTakeoverChat,
  useUpdateChat,
  getGetChatQueryKey,
  getGetCommonGroupsQueryKey,
  type Chat,
  type ChatUpdateStatus,
  type ChatUpdateTag,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";

const STATUS_OPTIONS: { value: ChatUpdateStatus; label: string }[] = [
  { value: "ai_handled", label: "AI" },
  { value: "needs_human", label: "Butuh Manusia" },
  { value: "closed", label: "Selesai" },
];

const TAG_OPTIONS: { value: ChatUpdateTag; label: string }[] = [
  { value: "none", label: "Tanpa Tag" },
  { value: "hot_lead", label: "Hot Lead" },
  { value: "cold", label: "Cold" },
  { value: "closing", label: "Closing" },
];

export function InfoTab({ chatId, chat }: { chatId: number; chat: Chat }) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data: labels } = useListCustomerLabels();
  const { data: commonGroups } = useGetCommonGroups(chatId, {
    query: {
      queryKey: getGetCommonGroupsQueryKey(chatId),
      enabled: Number.isFinite(chatId),
      retry: false,
    },
  });

  const updateChat = useUpdateChat();
  const takeover = useTakeoverChat();
  const setLabels = useSetChatLabels();

  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [company, setCompany] = useState("");
  const [savingText, setSavingText] = useState(false);

  // Initialise editable fields once per chat (avoid clobbering typing on poll).
  useEffect(() => {
    setCode(chat.customerCode ?? "");
    setNickname(chat.nickname ?? "");
    setCompany(chat.company ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });

  const saveText = async () => {
    setSavingText(true);
    try {
      await updateChat.mutateAsync({
        id: chatId,
        data: {
          customerCode: code.trim() || null,
          nickname: nickname.trim() || null,
          company: company.trim() || null,
        },
      });
      invalidate();
    } catch {
      // ignore
    } finally {
      setSavingText(false);
    }
  };

  const setStatus = async (status: ChatUpdateStatus) => {
    try {
      await updateChat.mutateAsync({ id: chatId, data: { status } });
      invalidate();
    } catch {
      // ignore
    }
  };

  const setTag = async (tag: ChatUpdateTag) => {
    try {
      await updateChat.mutateAsync({ id: chatId, data: { tag } });
      invalidate();
    } catch {
      // ignore
    }
  };

  const toggleTakeover = async (value: boolean) => {
    try {
      await takeover.mutateAsync({ id: chatId, data: { takeover: value } });
      invalidate();
    } catch {
      // ignore
    }
  };

  const toggleLabel = async (labelId: number) => {
    const current = chat.labels.map((l) => l.id);
    const next = current.includes(labelId)
      ? current.filter((x) => x !== labelId)
      : [...current, labelId];
    try {
      await setLabels.mutateAsync({ id: chatId, data: { labelIds: next } });
      invalidate();
    } catch {
      // ignore
    }
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: colors.secondary, color: colors.foreground },
  ];

  return (
    <ScrollView contentContainerStyle={styles.body}>
      {/* Editable contact fields */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Detail Kontak
      </Text>
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
          Kode Customer
        </Text>
        <TextInput
          style={inputStyle}
          value={code}
          onChangeText={setCode}
          placeholder="—"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
          Nama Tampilan
        </Text>
        <TextInput
          style={inputStyle}
          value={nickname}
          onChangeText={setNickname}
          placeholder={chat.contactName}
          placeholderTextColor={colors.mutedForeground}
        />
      </View>
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
          Perusahaan
        </Text>
        <TextInput
          style={inputStyle}
          value={company}
          onChangeText={setCompany}
          placeholder="—"
          placeholderTextColor={colors.mutedForeground}
        />
      </View>
      <TouchableOpacity
        onPress={saveText}
        disabled={savingText}
        style={[styles.saveBtn, { backgroundColor: colors.primary }]}
      >
        <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
          {savingText ? "Menyimpan…" : "Simpan"}
        </Text>
      </TouchableOpacity>

      {/* AI / manual takeover */}
      <View style={[styles.row, { marginTop: 18 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: colors.foreground }]}>
            Mode Manual
          </Text>
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            Aktif = AI berhenti membalas otomatis
          </Text>
        </View>
        <Switch
          value={chat.isHumanTakeover}
          onValueChange={toggleTakeover}
          trackColor={{ true: colors.primary, false: colors.muted }}
        />
      </View>

      {/* Status */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Status
      </Text>
      <View style={styles.pillWrap}>
        {STATUS_OPTIONS.map((o) => {
          const active = chat.status === o.value;
          return (
            <TouchableOpacity
              key={o.value}
              onPress={() => setStatus(o.value)}
              style={[
                styles.pill,
                {
                  backgroundColor: active ? colors.primary : colors.secondary,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  { color: active ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {o.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Tag */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Tag
      </Text>
      <View style={styles.pillWrap}>
        {TAG_OPTIONS.map((o) => {
          const active = chat.tag === o.value;
          return (
            <TouchableOpacity
              key={o.value}
              onPress={() => setTag(o.value)}
              style={[
                styles.pill,
                {
                  backgroundColor: active ? colors.primary : colors.secondary,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  { color: active ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {o.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Labels */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Label
      </Text>
      {(labels ?? []).length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>
          Belum ada label.
        </Text>
      ) : (
        <View style={styles.pillWrap}>
          {(labels ?? []).map((l) => {
            const active = chat.labels.some((x) => x.id === l.id);
            return (
              <TouchableOpacity
                key={l.id}
                onPress={() => toggleLabel(l.id)}
                style={[
                  styles.pill,
                  {
                    backgroundColor: active ? l.color + "22" : colors.secondary,
                    borderColor: active ? l.color : colors.border,
                  },
                ]}
              >
                <View style={[styles.dot, { backgroundColor: l.color }]} />
                <Text style={[styles.pillText, { color: colors.foreground }]}>
                  {l.name}
                </Text>
                {active ? (
                  <Feather name="check" size={13} color={l.color} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Common groups (1:1 only) */}
      {commonGroups && commonGroups.groups.length > 0 ? (
        <>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            Grup Bersama
          </Text>
          {commonGroups.groups.map((g) => (
            <View
              key={g.groupJid}
              style={[styles.groupRow, { borderColor: colors.border }]}
            >
              <Feather name="users" size={16} color={colors.mutedForeground} />
              <Text
                style={[styles.groupName, { color: colors.foreground }]}
                numberOfLines={1}
              >
                {g.subject}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 48 },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  field: { marginBottom: 12 },
  fieldLabel: { fontFamily: "Inter_500Medium", fontSize: 12, marginBottom: 4 },
  input: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  saveBtn: {
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowTitle: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  rowSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { fontFamily: "Inter_400Regular", fontSize: 14, paddingVertical: 8 },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupName: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 14 },
});
