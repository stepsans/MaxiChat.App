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
  useMuteChat,
  useBlockChat,
  getGetChatQueryKey,
  getGetCommonGroupsQueryKey,
  getListChatsQueryKey,
  type Chat,
  type ChatUpdateStatus,
  type ChatUpdateLeadStatus,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { usePermissions } from "@/hooks/usePermissions";

const STATUS_OPTIONS: { value: ChatUpdateStatus; label: string }[] = [
  { value: "ai_handled", label: "AI" },
  { value: "needs_human", label: "Butuh Manusia" },
  { value: "closed", label: "Selesai" },
];

// Status Lead (spec §5): keputusan manusia, 3 pilihan, default "Belum Tahu".
// Warna mengikuti makna — hijau Leads, merah Bukan Leads, abu Belum Tahu.
const LEAD_OPTIONS: {
  value: ChatUpdateLeadStatus;
  label: string;
  tone: "success" | "destructive" | "muted";
}[] = [
  { value: "lead", label: "Leads", tone: "success" },
  { value: "not_lead", label: "Bukan Leads", tone: "destructive" },
  { value: "unknown", label: "Belum Tahu", tone: "muted" },
];

export function InfoTab({
  chatId,
  chat,
  onAddToWorkboard,
}: {
  chatId: number;
  chat: Chat;
  /** Opens the "Tambah ke WorkBoard" sheet (lifted to the chat screen so the
   *  info panel can close first, avoiding a nested-modal stack). */
  onAddToWorkboard?: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  // WorkBoard task creation maps to the board "view" + editor role on the
  // backend (board creation is what "create" gates) — so canView is the right
  // visibility check here; super_admin always passes.
  const { can } = usePermissions();
  const canWorkboard = can("workboard").canView;

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
  const mute = useMuteChat();
  const block = useBlockChat();

  const isMuted = !!chat.mutedUntil && new Date(chat.mutedUntil) > new Date();
  const isGroup = chat.phoneNumber.endsWith("@g.us");

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

  // Optimistic: flip the lead pill instantly on both the open chat and the chat
  // list cache, roll back if the PATCH fails, then reconcile on success.
  const setLead = async (leadStatus: ChatUpdateLeadStatus) => {
    const chatKey = getGetChatQueryKey(chatId);
    const listKey = getListChatsQueryKey();
    await queryClient.cancelQueries({ queryKey: chatKey });
    const prevChat = queryClient.getQueryData<Chat>(chatKey);
    const prevList = queryClient.getQueryData<Chat[]>(listKey);
    const next = leadStatus as Chat["leadStatus"];
    if (prevChat) queryClient.setQueryData<Chat>(chatKey, { ...prevChat, leadStatus: next });
    if (prevList) {
      queryClient.setQueryData<Chat[]>(
        listKey,
        prevList.map((c) => (c.id === chatId ? { ...c, leadStatus: next } : c)),
      );
    }
    try {
      await updateChat.mutateAsync({ id: chatId, data: { leadStatus } });
      invalidate();
      queryClient.invalidateQueries({ queryKey: listKey });
    } catch {
      if (prevChat) queryClient.setQueryData(chatKey, prevChat);
      if (prevList) queryClient.setQueryData(listKey, prevList);
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

  const toggleMute = async (value: boolean) => {
    const mutedUntil = value
      ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
      : null;
    try {
      await mute.mutateAsync({ id: chatId, data: { mutedUntil } });
      invalidate();
    } catch {
      // ignore
    }
  };

  const toggleBlock = async (value: boolean) => {
    try {
      await block.mutateAsync({ id: chatId, data: { blocked: value } });
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

      {/* Tambah ke WorkBoard — buat task dari chat ini (gated by permission). */}
      {canWorkboard && onAddToWorkboard ? (
        <TouchableOpacity
          onPress={onAddToWorkboard}
          style={[styles.workboardBtn, { borderColor: colors.primary }]}
        >
          <Feather name="layout" size={16} color={colors.primary} />
          <Text style={[styles.workboardBtnText, { color: colors.primary }]}>
            Tambah ke WorkBoard
          </Text>
        </TouchableOpacity>
      ) : null}

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

      {/* Notifications */}
      <View style={[styles.row, { marginTop: 18 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: colors.foreground }]}>
            Bisukan Notifikasi
          </Text>
          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {isMuted ? "Dibisukan selama 8 jam" : "Notifikasi aktif"}
          </Text>
        </View>
        <Switch
          value={isMuted}
          onValueChange={toggleMute}
          trackColor={{ true: colors.primary, false: colors.muted }}
        />
      </View>

      {/* Block (1:1 only) */}
      {!isGroup ? (
        <View style={[styles.row, { marginTop: 18 }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.foreground }]}>
              Blokir Kontak
            </Text>
            <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
              {chat.isBlocked
                ? "Kontak diblokir di WhatsApp"
                : "Kontak dapat mengirim pesan"}
            </Text>
          </View>
          <Switch
            value={!!chat.isBlocked}
            onValueChange={toggleBlock}
            trackColor={{ true: colors.destructive, false: colors.muted }}
          />
        </View>
      ) : null}

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

      {/* Lead */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        Lead
      </Text>
      <View style={styles.pillWrap}>
        {LEAD_OPTIONS.map((o) => {
          const active = (chat.leadStatus ?? "unknown") === o.value;
          const tone = colors[o.tone];
          return (
            <TouchableOpacity
              key={o.value}
              onPress={() => setLead(o.value)}
              style={[
                styles.pill,
                {
                  backgroundColor: active ? tone : colors.secondary,
                  borderColor: active ? tone : colors.border,
                },
              ]}
            >
              <View style={[styles.dot, { backgroundColor: active ? "#ffffff" : tone }]} />
              <Text
                style={[
                  styles.pillText,
                  { color: active ? "#ffffff" : colors.foreground },
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
  workboardBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 11,
    marginTop: 10,
  },
  workboardBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
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
