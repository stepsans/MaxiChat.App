import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useGetChat,
  useGetChatAttachments,
  useListCustomerLabels,
  useSendManualReply,
  useSetChatLabels,
  getGetChatQueryKey,
  getGetChatAttachmentsQueryKey,
  type ChatMessage,
  type ChatAttachmentItem,
} from "@workspace/api-client-react";

import { Avatar } from "@/components/Avatar";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl, uploadChatMedia } from "@/lib/api";

function msgTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ConversationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Number(id);

  const { data: chat, isLoading } = useGetChat(chatId, {
    query: {
      queryKey: getGetChatQueryKey(chatId),
      enabled: Number.isFinite(chatId),
      refetchInterval: 4000,
    },
  });
  const { data: attachments } = useGetChatAttachments(chatId, {
    query: {
      queryKey: getGetChatAttachmentsQueryKey(chatId),
      enabled: Number.isFinite(chatId),
      refetchInterval: 10000,
    },
  });
  const { data: labels } = useListCustomerLabels();

  const sendReply = useSendManualReply();
  const setLabels = useSetChatLabels();

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [labelModal, setLabelModal] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Map message id -> media attachment so inbound/outbound images render inline.
  const mediaById = useMemo(() => {
    const m = new Map<number, ChatAttachmentItem>();
    for (const a of attachments?.media ?? []) m.set(a.id, a);
    return m;
  }, [attachments]);

  const invalidateChat = () =>
    queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });

  const messages = chat?.messages ?? [];
  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  const onSend = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setText("");
    try {
      await sendReply.mutateAsync({ id: chatId, data: { content } });
      invalidateChat();
    } catch {
      setText(content);
    } finally {
      setSending(false);
    }
  };

  const onAttach = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    setSending(true);
    try {
      await uploadChatMedia(
        chatId,
        {
          uri: asset.uri,
          name: asset.fileName || `image-${Date.now()}.jpg`,
          type: asset.mimeType || "image/jpeg",
        },
        "",
      );
      invalidateChat();
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  const toggleLabel = async (labelId: number) => {
    if (!chat) return;
    const current = chat.labels.map((l) => l.id);
    const nextIds = current.includes(labelId)
      ? current.filter((x) => x !== labelId)
      : [...current, labelId];
    try {
      await setLabels.mutateAsync({ id: chatId, data: { labelIds: nextIds } });
      invalidateChat();
    } catch {
      // ignore
    }
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const out = item.direction === "outbound";
    const media = mediaById.get(item.id);
    const mediaUri =
      media && (media.mediaType === "image" || media.mediaMimeType?.startsWith("image/"))
        ? resolveMediaUrl(media.mediaUrl)
        : null;
    return (
      <View
        style={[
          styles.bubbleRow,
          { justifyContent: out ? "flex-end" : "flex-start" },
        ]}
      >
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: out ? colors.bubbleOut : colors.bubbleIn,
              borderColor: colors.border,
            },
          ]}
        >
          {!out && item.senderName ? (
            <Text style={[styles.sender, { color: colors.primary }]}>
              {item.senderName}
            </Text>
          ) : null}
          {mediaUri ? (
            <Image source={{ uri: mediaUri }} style={styles.bubbleImage} />
          ) : null}
          {item.content ? (
            <Text
              style={[
                styles.bubbleText,
                { color: out ? colors.bubbleOutForeground : colors.foreground },
              ]}
            >
              {item.content}
            </Text>
          ) : null}
          <View style={styles.metaRow}>
            {item.isAiGenerated ? (
              <Feather name="cpu" size={11} color={colors.mutedForeground} />
            ) : null}
            <Text style={[styles.metaTime, { color: colors.mutedForeground }]}>
              {msgTime(item.createdAt)}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.chatBg }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 6, backgroundColor: colors.header },
        ]}
      >
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={24} color={colors.headerForeground} />
        </TouchableOpacity>
        <Avatar name={chat?.contactName || "?"} uri={chat?.profilePicUrl} size={38} />
        <View style={{ flex: 1 }}>
          <Text
            style={[styles.headerName, { color: colors.headerForeground }]}
            numberOfLines={1}
          >
            {chat?.nickname || chat?.contactName || "Memuat..."}
          </Text>
          {chat?.phoneNumber ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              {chat.phoneNumber}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => setLabelModal(true)}
          style={styles.backBtn}
        >
          <Feather name="tag" size={20} color={colors.headerForeground} />
        </TouchableOpacity>
      </View>

      {/* Label chips */}
      {chat && chat.labels.length > 0 ? (
        <View style={[styles.chipBar, { backgroundColor: colors.background }]}>
          {chat.labels.map((l) => (
            <View
              key={l.id}
              style={[styles.chip, { backgroundColor: l.color + "22" }]}
            >
              <View style={[styles.chipDot, { backgroundColor: l.color }]} />
              <Text style={[styles.chipText, { color: colors.foreground }]}>
                {l.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={inverted}
            inverted
            keyExtractor={(m) => String(m.id)}
            renderItem={renderMessage}
            contentContainerStyle={styles.messages}
          />
        )}

        {/* Composer */}
        <View
          style={[
            styles.composer,
            {
              paddingBottom: insets.bottom + 8,
              backgroundColor: colors.background,
              borderTopColor: colors.border,
            },
          ]}
        >
          <TouchableOpacity onPress={onAttach} style={styles.attachBtn}>
            <Feather name="paperclip" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.secondary,
                color: colors.foreground,
              },
            ]}
            placeholder="Ketik pesan"
            placeholderTextColor={colors.mutedForeground}
            value={text}
            onChangeText={setText}
            multiline
          />
          <TouchableOpacity
            onPress={onSend}
            disabled={!text.trim() || sending}
            style={[
              styles.sendBtn,
              {
                backgroundColor:
                  text.trim() && !sending ? colors.primary : colors.muted,
              },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Feather name="send" size={20} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Label editor modal */}
      <Modal
        visible={labelModal}
        transparent
        animationType="fade"
        onRequestClose={() => setLabelModal(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setLabelModal(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Label pelanggan
            </Text>
            {(labels ?? []).length === 0 ? (
              <Text style={[styles.muted, { color: colors.mutedForeground }]}>
                Belum ada label.
              </Text>
            ) : (
              (labels ?? []).map((l) => {
                const active = chat?.labels.some((x) => x.id === l.id);
                return (
                  <TouchableOpacity
                    key={l.id}
                    style={styles.modalRow}
                    onPress={() => toggleLabel(l.id)}
                  >
                    <View style={[styles.chipDot, { backgroundColor: l.color }]} />
                    <Text style={[styles.modalRowText, { color: colors.foreground }]}>
                      {l.name}
                    </Text>
                    {active ? (
                      <Feather name="check" size={18} color={colors.primary} />
                    ) : null}
                  </TouchableOpacity>
                );
              })
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  backBtn: { padding: 4 },
  headerName: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: "rgba(255,255,255,0.8)",
    marginTop: 1,
  },
  chipBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 12,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  messages: { paddingHorizontal: 10, paddingVertical: 12 },
  bubbleRow: { flexDirection: "row", marginVertical: 2 },
  bubble: {
    maxWidth: "82%",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sender: { fontFamily: "Inter_600SemiBold", fontSize: 12, marginBottom: 2 },
  bubbleImage: {
    width: 220,
    height: 220,
    borderRadius: 8,
    marginBottom: 4,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  bubbleText: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 20 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-end",
    marginTop: 2,
  },
  metaTime: { fontFamily: "Inter_400Regular", fontSize: 10 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  attachBtn: { padding: 8 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderRadius: 21,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    padding: 24,
  },
  modalSheet: { borderRadius: 16, padding: 16 },
  modalTitle: { fontFamily: "Inter_700Bold", fontSize: 17, marginBottom: 8 },
  muted: { fontFamily: "Inter_400Regular", fontSize: 14, paddingVertical: 12 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  modalRowText: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 15 },
});
