import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  useDeleteMessageForMe,
  useEditMessage,
  useForwardMessage,
  useGetChat,
  useGetChatAttachments,
  useListChats,
  useListCustomerLabels,
  useOpenChatByPhone,
  useReactMessage,
  useRevokeMessage,
  useSendManualReply,
  useSetChatLabels,
  useSetMessagePin,
  useSetMessageStar,
  getGetChatQueryKey,
  getGetChatAttachmentsQueryKey,
  getListChatsQueryKey,
  type Chat,
  type ChatMessage,
  type ChatAttachmentItem,
} from "@workspace/api-client-react";

import { Avatar } from "@/components/Avatar";
import {
  LinkifiedText,
  LinkPreviewCard,
  firstLink,
} from "@/components/MessageBody";
import { VoiceNote } from "@/components/VoiceNote";
import { ChatInfoPanel } from "@/components/chat-info/ChatInfoPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl, uploadChatMedia } from "@/lib/api";

const AVATAR_SIZE = 30;
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function msgTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Identity key used to group consecutive messages from the same sender so the
// avatar is only rendered once per run. Outbound is always "us"; inbound groups
// key on the participant (digits → name), 1:1 inbound collapses to a single key.
function senderKey(m: ChatMessage): string {
  if (m.direction === "outbound") return "out";
  return "in:" + (m.senderPhoneDigits ?? m.senderName ?? "self");
}

export default function ConversationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
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
  const [infoOpen, setInfoOpen] = useState(false);

  // Message-action state.
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [forwardSelected, setForwardSelected] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Reset all transient per-conversation state when the chat changes, otherwise
  // a reply/edit/select started in one chat leaks into the next (e.g. "Balas
  // pribadi" navigates to another chat) — including a stale quotedMessageId.
  React.useEffect(() => {
    setText("");
    setReplyTo(null);
    setEditTarget(null);
    setActionTarget(null);
    setForwardSource(null);
    setForwardSelected(new Set());
    setSelectMode(false);
    setSelected(new Set());
  }, [chatId]);

  // Map message id -> media attachment so inbound/outbound media renders inline.
  const mediaById = useMemo(() => {
    const m = new Map<number, ChatAttachmentItem>();
    for (const a of attachments?.media ?? []) m.set(a.id, a);
    return m;
  }, [attachments]);

  const invalidateChat = () =>
    queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
  const invalidateLists = () => {
    invalidateChat();
    queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() });
  };

  const messages = chat?.messages ?? [];
  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  // ---- Mutations -----------------------------------------------------------
  const reactMut = useReactMessage();
  const starMut = useSetMessageStar();
  const pinMut = useSetMessagePin();
  const deleteForMeMut = useDeleteMessageForMe();
  const revokeMut = useRevokeMessage();
  const forwardMut = useForwardMessage();
  const editMut = useEditMessage();
  const openByPhoneMut = useOpenChatByPhone();

  // Chat list for the forward picker, only fetched while the dialog is open.
  const { data: forwardChats } = useListChats(undefined, {
    query: {
      queryKey: getListChatsQueryKey(),
      enabled: forwardSource != null,
    },
  });

  const onSend = async () => {
    const content = text.trim();
    if (!content || sending) return;

    // Edit mode: PATCH the existing message instead of sending a new one.
    if (editTarget) {
      const target = editTarget;
      setSending(true);
      try {
        await editMut.mutateAsync({
          id: chatId,
          messageId: target.id,
          data: { content },
        });
        setText("");
        setEditTarget(null);
        invalidateChat();
      } catch (e: any) {
        Alert.alert("Gagal mengedit", e?.message ?? "Coba lagi.");
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    setText("");
    const quoted = replyTo;
    setReplyTo(null);
    try {
      await sendReply.mutateAsync({
        id: chatId,
        data: {
          content,
          ...(quoted ? { quotedMessageId: quoted.id } : {}),
        },
      });
      invalidateChat();
    } catch {
      setText(content);
      setReplyTo(quoted);
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

  // ---- Action handlers -----------------------------------------------------
  const closeActions = () => setActionTarget(null);

  const doReact = (m: ChatMessage, emoji: string) => {
    closeActions();
    reactMut.mutate(
      { id: chatId, messageId: m.id, data: { emoji } },
      { onSuccess: invalidateChat },
    );
  };

  const doStar = (m: ChatMessage) => {
    closeActions();
    starMut.mutate(
      { id: chatId, messageId: m.id, data: { starred: !m.isStarred } },
      { onSuccess: invalidateChat },
    );
  };

  const doPin = (m: ChatMessage) => {
    closeActions();
    pinMut.mutate(
      { id: chatId, messageId: m.id, data: { pinned: !m.pinnedAt } },
      { onSuccess: invalidateChat },
    );
  };

  const doCopy = async (m: ChatMessage) => {
    closeActions();
    if (m.content) await Clipboard.setStringAsync(m.content);
  };

  const doReply = (m: ChatMessage) => {
    closeActions();
    setEditTarget(null);
    setReplyTo(m);
  };

  const doEdit = (m: ChatMessage) => {
    closeActions();
    setReplyTo(null);
    setEditTarget(m);
    setText(m.content);
  };

  const doDeleteForMe = (m: ChatMessage) => {
    closeActions();
    deleteForMeMut.mutate(
      { id: chatId, messageId: m.id },
      { onSuccess: invalidateLists },
    );
  };

  const doRevoke = (m: ChatMessage) => {
    closeActions();
    Alert.alert(
      "Hapus untuk semua orang?",
      "Pesan akan ditarik dari WhatsApp/Telegram penerima.",
      [
        { text: "Batal", style: "cancel" },
        {
          text: "Hapus",
          style: "destructive",
          onPress: () =>
            revokeMut.mutate(
              { id: chatId, messageId: m.id },
              {
                onSuccess: invalidateLists,
                onError: (e: any) =>
                  Alert.alert("Gagal", e?.message ?? "Coba lagi."),
              },
            ),
        },
      ],
    );
  };

  const doReplyPrivately = (m: ChatMessage) => {
    closeActions();
    const phone = m.senderPhoneDigits;
    if (!phone) {
      Alert.alert("Nomor anggota tidak diketahui.");
      return;
    }
    openByPhoneMut.mutate(
      { data: { phoneNumber: phone, ...(m.senderName ? { contactName: m.senderName } : {}) } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() });
          router.push(`/chat/${result.chatId}`);
        },
        onError: (e: any) => Alert.alert("Gagal", e?.message ?? "Coba lagi."),
      },
    );
  };

  const doForward = (m: ChatMessage) => {
    closeActions();
    setForwardSelected(new Set());
    setForwardSource(m);
  };

  const submitForward = () => {
    if (!forwardSource || forwardSelected.size === 0) return;
    forwardMut.mutate(
      {
        id: chatId,
        messageId: forwardSource.id,
        data: { targetChatIds: Array.from(forwardSelected) },
      },
      {
        onSuccess: (data) => {
          setForwardSource(null);
          setForwardSelected(new Set());
          Alert.alert(
            "Diteruskan",
            data.failed > 0
              ? `Terkirim ke ${data.sent} chat, ${data.failed} gagal.`
              : `Pesan diteruskan ke ${data.sent} chat.`,
          );
          invalidateLists();
        },
        onError: (e: any) => Alert.alert("Gagal meneruskan", e?.message ?? "Coba lagi."),
      },
    );
  };

  const enterSelect = (m: ChatMessage) => {
    closeActions();
    setSelectMode(true);
    setSelected(new Set([m.id]));
  };

  const toggleSelect = (m: ChatMessage) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const deleteSelected = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    Alert.alert("Hapus pesan terpilih?", `${ids.length} pesan akan dihapus untuk Anda.`, [
      { text: "Batal", style: "cancel" },
      {
        text: "Hapus",
        style: "destructive",
        onPress: () => {
          for (const mid of ids) {
            deleteForMeMut.mutate({ id: chatId, messageId: mid });
          }
          exitSelect();
          invalidateLists();
        },
      },
    ]);
  };

  // ---- Render --------------------------------------------------------------
  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const out = item.direction === "outbound";
    const media = mediaById.get(item.id);
    const mType = media?.mediaType ?? "";
    const isImage =
      media && (mType === "image" || media.mediaMimeType?.startsWith("image/"));
    const isSticker = media && mType === "sticker";
    const isAudio =
      media && (mType === "audio" || media.mediaMimeType?.startsWith("audio/"));
    const imageUri = isImage || isSticker ? resolveMediaUrl(media!.mediaUrl) : null;
    const audioUri = isAudio ? resolveMediaUrl(media!.mediaUrl) : null;
    const link = item.content ? firstLink(item.content) : null;
    const isSelected = selected.has(item.id);

    const newer = index > 0 ? inverted[index - 1] : null;
    const showAvatar = !newer || senderKey(newer) !== senderKey(item);

    const isGroupSender = !out && !!(item.senderPhoneDigits || item.senderName);
    const avatarName = out
      ? user?.name || "Saya"
      : isGroupSender
        ? item.senderName || item.senderPhoneDigits || "?"
        : chat?.contactName || "?";
    const avatarUri = out
      ? resolveMediaUrl(user?.profilePhotoUrl)
      : isGroupSender
        ? null
        : chat?.profilePicUrl;

    const avatarSlot = showAvatar ? (
      <Avatar name={avatarName} uri={avatarUri} size={AVATAR_SIZE} />
    ) : (
      <View style={{ width: AVATAR_SIZE }} />
    );

    const onPress = () => {
      if (selectMode) toggleSelect(item);
    };
    const onLongPress = () => {
      if (!selectMode) setActionTarget(item);
    };

    // Stickers render bare (transparent, no bubble chrome).
    const bareSticker = isSticker && !item.content && !link;

    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={250}
        style={[
          styles.bubbleRow,
          { justifyContent: out ? "flex-end" : "flex-start" },
          isSelected && { backgroundColor: colors.primary + "22", borderRadius: 8 },
        ]}
      >
        {!out ? avatarSlot : null}
        {bareSticker ? (
          <Image source={{ uri: imageUri! }} style={styles.sticker} resizeMode="contain" />
        ) : (
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

            {item.isForwarded ? (
              <View style={styles.fwdRow}>
                <Feather name="corner-up-right" size={11} color={colors.mutedForeground} />
                <Text style={[styles.fwdText, { color: colors.mutedForeground }]}>
                  {(item.forwardingScore ?? 0) >= 4
                    ? "Diteruskan berkali-kali"
                    : "Diteruskan"}
                </Text>
              </View>
            ) : null}

            {item.quotedContent ? (
              <View style={[styles.quoteBar, { borderLeftColor: colors.primary, backgroundColor: colors.secondary }]}>
                {item.quotedSender ? (
                  <Text style={[styles.quoteSender, { color: colors.primary }]} numberOfLines={1}>
                    {item.quotedSender}
                  </Text>
                ) : null}
                <Text style={[styles.quoteText, { color: colors.mutedForeground }]} numberOfLines={2}>
                  {item.quotedContent}
                </Text>
              </View>
            ) : null}

            {isSticker && imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.sticker} resizeMode="contain" />
            ) : imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.bubbleImage} />
            ) : null}

            {audioUri ? (
              <VoiceNote
                uri={audioUri}
                tint={colors.primary}
                trackColor={out ? colors.bubbleOutForeground : colors.mutedForeground}
              />
            ) : null}

            {link ? <LinkPreviewCard url={link} isOutbound={out} /> : null}
            {item.content ? (
              <LinkifiedText
                content={item.content}
                color={out ? colors.bubbleOutForeground : colors.foreground}
                linkColor={out ? colors.bubbleOutForeground : colors.primary}
                style={styles.bubbleText}
              />
            ) : null}

            {item.reactions && item.reactions.length > 0 ? (
              <View style={[styles.reactionBar, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                {item.reactions.map((r, i) => (
                  <Text key={i} style={styles.reactionEmoji}>
                    {r.emoji}
                  </Text>
                ))}
              </View>
            ) : null}

            <View style={styles.metaRow}>
              {item.editedAt ? (
                <Text style={[styles.metaTime, { color: colors.mutedForeground }]}>diedit</Text>
              ) : null}
              {item.isStarred ? (
                <Feather name="star" size={11} color={colors.mutedForeground} />
              ) : null}
              {item.pinnedAt ? (
                <Feather name="bookmark" size={11} color={colors.mutedForeground} />
              ) : null}
              {item.isAiGenerated ? (
                <Feather name="cpu" size={11} color={colors.mutedForeground} />
              ) : null}
              <Text style={[styles.metaTime, { color: colors.mutedForeground }]}>
                {msgTime(item.createdAt)}
              </Text>
            </View>
          </View>
        )}
        {out ? avatarSlot : null}
      </Pressable>
    );
  };

  const target = actionTarget;
  const targetOut = target?.direction === "outbound";
  const targetIsGroupInbound =
    !!target && target.direction === "inbound" && !!target.senderPhoneDigits;

  return (
    <View style={[styles.container, { backgroundColor: colors.chatBg }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 6, backgroundColor: colors.header },
        ]}
      >
        {selectMode ? (
          <>
            <TouchableOpacity onPress={exitSelect} style={styles.backBtn}>
              <Feather name="x" size={24} color={colors.headerForeground} />
            </TouchableOpacity>
            <Text style={[styles.headerName, { color: colors.headerForeground, flex: 1 }]}>
              {selected.size} dipilih
            </Text>
            <TouchableOpacity onPress={deleteSelected} style={styles.backBtn}>
              <Feather name="trash-2" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
          </>
        ) : (
          <>
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
            <TouchableOpacity onPress={() => setLabelModal(true)} style={styles.backBtn}>
              <Feather name="tag" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setInfoOpen(true)} style={styles.backBtn}>
              <Feather name="info" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
          </>
        )}
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

        {/* Reply / edit preview */}
        {replyTo || editTarget ? (
          <View
            style={[
              styles.replyPreview,
              { backgroundColor: colors.secondary, borderLeftColor: colors.primary },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.quoteSender, { color: colors.primary }]}>
                {editTarget ? "Edit pesan" : "Membalas"}
              </Text>
              <Text style={[styles.quoteText, { color: colors.mutedForeground }]} numberOfLines={1}>
                {(editTarget ?? replyTo)?.content || "Media"}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                setReplyTo(null);
                if (editTarget) {
                  setEditTarget(null);
                  setText("");
                }
              }}
            >
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        ) : null}

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
          {!editTarget ? (
            <TouchableOpacity onPress={onAttach} style={styles.attachBtn}>
              <Feather name="paperclip" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          ) : null}
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.secondary, color: colors.foreground },
            ]}
            placeholder={editTarget ? "Edit pesan" : "Ketik pesan"}
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
              { backgroundColor: text.trim() && !sending ? colors.primary : colors.muted },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Feather name={editTarget ? "check" : "send"} size={20} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Message actions sheet */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={closeActions}
      >
        <Pressable style={styles.modalBackdrop} onPress={closeActions}>
          <Pressable style={[styles.actionSheet, { backgroundColor: colors.card }]}>
            {/* Emoji reaction bar */}
            <View style={[styles.emojiBar, { borderBottomColor: colors.border }]}>
              {QUICK_EMOJIS.map((e) => (
                <TouchableOpacity key={e} onPress={() => target && doReact(target, e)}>
                  <Text style={styles.emojiBtn}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {target ? (
              <View style={styles.actionList}>
                <ActionRow icon="corner-up-left" label="Balas" color={colors.foreground} onPress={() => doReply(target)} />
                {targetIsGroupInbound ? (
                  <ActionRow icon="user" label="Balas pribadi" color={colors.foreground} onPress={() => doReplyPrivately(target)} />
                ) : null}
                {target.content ? (
                  <ActionRow icon="copy" label="Salin" color={colors.foreground} onPress={() => doCopy(target)} />
                ) : null}
                <ActionRow
                  icon="star"
                  label={target.isStarred ? "Hapus bintang" : "Bintang"}
                  color={colors.foreground}
                  onPress={() => doStar(target)}
                />
                <ActionRow
                  icon="bookmark"
                  label={target.pinnedAt ? "Lepas sematan" : "Sematkan"}
                  color={colors.foreground}
                  onPress={() => doPin(target)}
                />
                <ActionRow icon="corner-up-right" label="Teruskan" color={colors.foreground} onPress={() => doForward(target)} />
                {targetOut && !mediaById.get(target.id) ? (
                  <ActionRow icon="edit-2" label="Edit" color={colors.foreground} onPress={() => doEdit(target)} />
                ) : null}
                <ActionRow icon="check-square" label="Pilih" color={colors.foreground} onPress={() => enterSelect(target)} />
                <ActionRow icon="trash" label="Hapus untuk saya" color={colors.destructive} onPress={() => doDeleteForMe(target)} />
                {targetOut ? (
                  <ActionRow icon="trash-2" label="Hapus untuk semua" color={colors.destructive} onPress={() => doRevoke(target)} />
                ) : null}
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Forward picker */}
      <Modal
        visible={!!forwardSource}
        transparent
        animationType="slide"
        onRequestClose={() => setForwardSource(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setForwardSource(null)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card, maxHeight: "75%" }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Teruskan ke
            </Text>
            <FlatList
              data={(forwardChats ?? []).filter((c) => c.id !== chatId)}
              keyExtractor={(c) => String(c.id)}
              renderItem={({ item }: { item: Chat }) => {
                const checked = forwardSelected.has(item.id);
                return (
                  <TouchableOpacity
                    style={styles.modalRow}
                    onPress={() =>
                      setForwardSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    <Avatar name={item.contactName} uri={item.profilePicUrl} size={36} />
                    <Text style={[styles.modalRowText, { color: colors.foreground }]} numberOfLines={1}>
                      {item.nickname || item.contactName}
                    </Text>
                    <Feather
                      name={checked ? "check-circle" : "circle"}
                      size={20}
                      color={checked ? colors.primary : colors.mutedForeground}
                    />
                  </TouchableOpacity>
                );
              }}
            />
            <TouchableOpacity
              onPress={submitForward}
              disabled={forwardSelected.size === 0}
              style={[
                styles.fwdSubmit,
                {
                  backgroundColor:
                    forwardSelected.size > 0 ? colors.primary : colors.muted,
                },
              ]}
            >
              <Text style={styles.fwdSubmitText}>
                Teruskan{forwardSelected.size > 0 ? ` (${forwardSelected.size})` : ""}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

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

      <ChatInfoPanel
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        chatId={chatId}
        chat={chat}
      />
    </View>
  );
}

function ActionRow({
  icon,
  label,
  color,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.actionRow} onPress={onPress}>
      <Feather name={icon} size={20} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
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
  bubbleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    marginVertical: 2,
    paddingHorizontal: 2,
  },
  bubble: {
    maxWidth: "78%",
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
  sticker: { width: 140, height: 140, marginBottom: 2 },
  bubbleText: { fontFamily: "Inter_400Regular", fontSize: 15, lineHeight: 20 },
  fwdRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 },
  fwdText: { fontFamily: "Inter_400Regular", fontSize: 11, fontStyle: "italic" },
  quoteBar: {
    borderLeftWidth: 3,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 4,
  },
  quoteSender: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  quoteText: { fontFamily: "Inter_400Regular", fontSize: 13 },
  reactionBar: {
    flexDirection: "row",
    gap: 2,
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
  },
  reactionEmoji: { fontSize: 13 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-end",
    marginTop: 2,
  },
  metaTime: { fontFamily: "Inter_400Regular", fontSize: 10 },
  replyPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderLeftWidth: 3,
    marginHorizontal: 8,
    marginBottom: 4,
    borderRadius: 6,
  },
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
  actionSheet: { borderRadius: 16, overflow: "hidden" },
  emojiBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  emojiBtn: { fontSize: 26 },
  actionList: { paddingVertical: 4 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  actionLabel: { fontFamily: "Inter_500Medium", fontSize: 15 },
  fwdSubmit: {
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
  },
  fwdSubmitText: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: "#fff" },
});
