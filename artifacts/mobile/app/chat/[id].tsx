import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Contacts from "expo-contacts";
import { Image } from "expo-image";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
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
  useGetStarredMessages,
  useMuteChat,
  useBlockChat,
  useSendLocationToChat,
  useSendContactToChat,
  useListShortcuts,
  getGetChatQueryKey,
  getGetChatAttachmentsQueryKey,
  getGetStarredMessagesQueryKey,
  getListChatsQueryKey,
  type Chat,
  type ChatMessage,
  type ChatAttachmentItem,
} from "@workspace/api-client-react";

import { Avatar } from "@/components/Avatar";
import { ChatVideo } from "@/components/ChatVideo";
import { ImageLightbox } from "@/components/ImageLightbox";
import {
  LinkifiedText,
  LinkPreviewCard,
  firstLink,
} from "@/components/MessageBody";
import { VoiceNote } from "@/components/VoiceNote";
import { VoiceRecorder, type RecordedVoiceNote } from "@/components/VoiceRecorder";
import { ChatInfoPanel, type TabKey } from "@/components/chat-info/ChatInfoPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useColors } from "@/hooks/useColors";
import {
  resolveMediaUrl,
  uploadChatMedia,
  uploadChatAlbum,
  uploadVoiceNote,
} from "@/lib/api";

const AVATAR_SIZE = 30;
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Fallback bila tenant belum punya shortcut "/almt" — minta alamat pengiriman.
const DEFAULT_ALMT_TEMPLATE =
  "Mohon kirimkan alamat lengkap pengiriman ya kak 🙏\n\n" +
  "Nama penerima:\nNo. HP:\nAlamat lengkap:\nKecamatan:\nKota/Kabupaten:\nProvinsi:\nKode pos:";

function msgTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Human-readable header presence line from the chat's live presence payload:
// "online" / "mengetik…" / "merekam suara…" / "terakhir dilihat …".
function presenceLabel(
  presence: { status?: string | null; lastSeen?: number | null } | null | undefined,
): string | null {
  if (!presence) return null;
  if (presence.status === "composing") return "mengetik…";
  if (presence.status === "recording") return "merekam suara…";
  if (presence.status === "available") return "online";
  if (presence.lastSeen) {
    const d = new Date(presence.lastSeen * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const when = sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
    return `terakhir dilihat ${when}`;
  }
  return null;
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
  const { wallpaper } = useTheme();
  const chatBg = wallpaper && wallpaper !== "default" ? wallpaper : colors.chatBg;
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
  const { data: shortcuts } = useListShortcuts();

  const sendReply = useSendManualReply();
  const setLabels = useSetChatLabels();

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [labelModal, setLabelModal] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<TabKey>("info");

  // WhatsApp-parity chat-room surfaces.
  const [photoOpen, setPhotoOpen] = useState(false);
  // Full-screen lightbox for an inbound/outbound chat image (url being viewed).
  const [imageView, setImageView] = useState<string | null>(null);

  // Buka URL eksternal (dokumen/telepon) di app penanganan device.
  const openExternal = (url: string) => Linking.openURL(url).catch(() => {});

  // Buka koordinat ("lat,lng") di app Google Maps HP. Android: skema `geo:`
  // membuka app peta langsung; iOS/lainnya: URL universal Google Maps yang
  // membuka app-nya bila terpasang (kalau gagal, jatuh ke browser).
  const openMaps = (coords: string) => {
    const universal = `https://www.google.com/maps/search/?api=1&query=${coords}`;
    const url = Platform.select({
      android: `geo:${coords}?q=${coords}`,
      default: universal,
    })!;
    Linking.openURL(url).catch(() => Linking.openURL(universal).catch(() => {}));
  };

  // Chip "/almt" — sisipkan template minta-alamat ke komposer agar agent bisa
  // tinjau/ubah sebelum kirim. Pakai shortcut "/almt" milik tenant bila ada,
  // jika tidak pakai template default.
  const insertAlamat = () => {
    const entry = (shortcuts ?? []).find(
      (s) => s.shortcut.toLowerCase() === "/almt",
    );
    const tpl = entry?.replacement ?? DEFAULT_ALMT_TEMPLATE;
    setText((t) => (t.trim() ? `${t.trimEnd()}\n${tpl}` : tpl));
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [starredOpen, setStarredOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: starred, isLoading: starredLoading } = useGetStarredMessages(
    chatId,
    {
      query: {
        queryKey: getGetStarredMessagesQueryKey(chatId),
        enabled: Number.isFinite(chatId) && starredOpen,
      },
    },
  );

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

  // In-chat search: filter the (inverted) list by message text when the search
  // bar is open and has a query.
  const visibleMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!searchOpen || !q) return inverted;
    return inverted.filter((m) => (m.content ?? "").toLowerCase().includes(q));
  }, [inverted, searchOpen, searchQuery]);

  // ---- Mutations -----------------------------------------------------------
  const reactMut = useReactMessage();
  const starMut = useSetMessageStar();
  const pinMut = useSetMessagePin();
  const deleteForMeMut = useDeleteMessageForMe();
  const revokeMut = useRevokeMessage();
  const forwardMut = useForwardMessage();
  const editMut = useEditMessage();
  const openByPhoneMut = useOpenChatByPhone();
  const muteMut = useMuteChat();
  const blockMut = useBlockChat();
  const sendLocationMut = useSendLocationToChat();
  const sendContactMut = useSendContactToChat();

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

  // Open the right-side info panel focused on a specific tab (used by the
  // quick chips above the composer: Pesan Cepat / Produk / Order).
  const openPanel = (t: TabKey) => {
    setInfoTab(t);
    setInfoOpen(true);
  };

  const uploadAssets = async (assets: ImagePicker.ImagePickerAsset[]) => {
    if (assets.length === 0) return;
    setSending(true);
    try {
      const toFile = (asset: ImagePicker.ImagePickerAsset) => {
        const isVideo = asset.type === "video";
        return {
          uri: asset.uri,
          name:
            asset.fileName ||
            `${isVideo ? "video" : "image"}-${Date.now()}.${isVideo ? "mp4" : "jpg"}`,
          type: asset.mimeType || (isVideo ? "video/mp4" : "image/jpeg"),
        };
      };
      if (assets.length === 1) {
        await uploadChatMedia(chatId, toFile(assets[0]), "");
      } else {
        // Album: one request; the backend sends the items as a paced sequence.
        await uploadChatAlbum(chatId, assets.map(toFile), "");
      }
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal mengirim", e?.message ?? "Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  // Galeri — multi-select (album) photos & videos.
  const onPickGallery = async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.8,
    });
    if (res.canceled) return;
    await uploadAssets(res.assets);
  };

  // Kamera — capture a single photo.
  const onPickCamera = async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Izin diperlukan", "Beri akses kamera untuk mengambil foto.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (res.canceled) return;
    await uploadAssets(res.assets);
  };

  const onSendVoiceNote = async (file: RecordedVoiceNote) => {
    setRecording(false);
    setSending(true);
    try {
      await uploadVoiceNote(chatId, file);
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal mengirim pesan suara", e?.message ?? "Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  // Ekspor Chat — share a plain-text transcript of the loaded conversation.
  const onExportChat = async () => {
    setMenuOpen(false);
    const who = chat?.nickname || chat?.contactName || "Chat";
    const lines = messages.map((m) => {
      const sender =
        m.direction === "outbound" ? user?.name || "Saya" : m.senderName || who;
      const stamp = new Date(m.createdAt).toLocaleString();
      const bodyText = m.content || "[media]";
      return `[${stamp}] ${sender}: ${bodyText}`;
    });
    const transcript = `Riwayat chat — ${who}\n\n${lines.join("\n")}`;
    try {
      await Share.share({ message: transcript });
    } catch {
      // ignore
    }
  };

  // Dokumen — pick any file and send through the chat media endpoint.
  const onPickDocument = async () => {
    setAttachOpen(false);
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setSending(true);
    try {
      await uploadChatMedia(
        chatId,
        {
          uri: a.uri,
          name: a.name || `dokumen-${Date.now()}`,
          type: a.mimeType || "application/octet-stream",
        },
        "",
      );
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal mengirim dokumen", e?.message ?? "Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  // Lokasi — share the device's current position.
  const onSendLocation = async () => {
    setAttachOpen(false);
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Izin diperlukan", "Beri akses lokasi untuk membagikan posisi.");
      return;
    }
    setSending(true);
    try {
      const pos = await Location.getCurrentPositionAsync({});
      await sendLocationMut.mutateAsync({
        id: chatId,
        data: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        },
      });
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal mengirim lokasi", e?.message ?? "Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  // Kontak — pick a phone contact and send it as a vCard.
  const onPickContact = async () => {
    setAttachOpen(false);
    const perm = await Contacts.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Izin diperlukan", "Beri akses kontak untuk membagikan kontak.");
      return;
    }
    const picked = await Contacts.presentContactPickerAsync();
    if (!picked) return;
    const phone = picked.phoneNumbers?.[0]?.number;
    const name = picked.name || "Kontak";
    if (!phone) {
      Alert.alert("Kontak tanpa nomor", "Kontak yang dipilih tidak punya nomor telepon.");
      return;
    }
    setSending(true);
    try {
      await sendContactMut.mutateAsync({
        id: chatId,
        data: { name, phoneNumber: phone },
      });
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal mengirim kontak", e?.message ?? "Coba lagi.");
    } finally {
      setSending(false);
    }
  };

  // Bisukan / bunyikan — toggle a mute that expires in 8 hours.
  const onToggleMute = async () => {
    setMenuOpen(false);
    const muted = !!chat?.mutedUntil && new Date(chat.mutedUntil) > new Date();
    const until = muted
      ? null
      : new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    try {
      await muteMut.mutateAsync({ id: chatId, data: { mutedUntil: until } });
      invalidateChat();
    } catch (e: any) {
      Alert.alert("Gagal", e?.message ?? "Coba lagi.");
    }
  };

  // Blokir / buka blokir.
  const onToggleBlock = async () => {
    setMenuOpen(false);
    const blocked = !!chat?.isBlocked;
    const confirmAndRun = () => {
      blockMut.mutate(
        { id: chatId, data: { blocked: !blocked } },
        {
          onSuccess: invalidateChat,
          onError: (e: any) => Alert.alert("Gagal", e?.message ?? "Coba lagi."),
        },
      );
    };
    if (blocked) {
      confirmAndRun();
    } else {
      Alert.alert(
        "Blokir kontak?",
        "Kontak ini tidak akan bisa mengirim pesan ke Anda di WhatsApp.",
        [
          { text: "Batal", style: "cancel" },
          { text: "Blokir", style: "destructive", onPress: confirmAndRun },
        ],
      );
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
    const isVideo =
      media && (mType === "video" || media.mediaMimeType?.startsWith("video/"));
    const isDoc = media && mType === "document";
    const isContact = media && mType === "contact";
    // Lokasi keluar (dikirim app) punya media row mediaType="location" +
    // mediaUrl "geo:lat,lng". Lokasi masuk hanya teks diawali 📍 (tanpa koordinat).
    const isLocation =
      (media && mType === "location") || (!media && /^📍/.test(item.content ?? ""));
    const imageUri = isImage || isSticker ? resolveMediaUrl(media!.mediaUrl) : null;
    const audioUri = isAudio ? resolveMediaUrl(media!.mediaUrl) : null;
    const videoUri = isVideo ? resolveMediaUrl(media!.mediaUrl) : null;
    const docUri = isDoc ? resolveMediaUrl(media!.mediaUrl) : null;
    const geoCoords =
      media?.mediaUrl && media.mediaUrl.startsWith("geo:")
        ? media.mediaUrl.slice(4)
        : null;
    // Kontak: nama dari mediaFilename; nomor (bila ada) diparse dari "Nama (nomor)".
    const contactName = isContact
      ? media!.mediaFilename || item.content || "Kontak"
      : null;
    const contactPhone = isContact
      ? (item.content ?? "").match(/\(([+0-9][0-9\s-]{5,})\)/)?.[1]?.replace(/[\s-]/g, "") ?? null
      : null;
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
          <Image
            source={{ uri: imageUri! }}
            style={styles.sticker}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={120}
          />
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
              <Image
                source={{ uri: imageUri }}
                style={styles.sticker}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={120}
              />
            ) : imageUri ? (
              <TouchableOpacity activeOpacity={0.9} onPress={() => setImageView(imageUri)}>
                <Image
                  source={{ uri: imageUri }}
                  style={styles.bubbleImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={120}
                />
              </TouchableOpacity>
            ) : null}

            {videoUri ? <ChatVideo uri={videoUri} /> : null}

            {docUri ? (
              <TouchableOpacity
                style={[styles.fileCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                onPress={() => openExternal(docUri)}
                activeOpacity={0.7}
              >
                <Feather name="file-text" size={22} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.fileName, { color: colors.foreground }]} numberOfLines={2}>
                    {media!.mediaFilename || "Dokumen"}
                  </Text>
                  <Text style={[styles.fileMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {media!.mediaMimeType || "Berkas"}
                  </Text>
                </View>
                <Feather name="download" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            ) : null}

            {isContact ? (
              <TouchableOpacity
                style={[styles.attachCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                onPress={contactPhone ? () => openExternal(`tel:${contactPhone}`) : undefined}
                activeOpacity={contactPhone ? 0.7 : 1}
                disabled={!contactPhone}
              >
                <View style={[styles.attachAvatar, { backgroundColor: colors.primary + "22" }]}>
                  <Feather name="user" size={20} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.attachTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {contactName}
                  </Text>
                  <Text style={[styles.fileMeta, { color: colors.mutedForeground }]}>
                    {contactPhone ?? "Kontak"}
                  </Text>
                </View>
                {contactPhone ? <Feather name="phone" size={18} color={colors.success} /> : null}
              </TouchableOpacity>
            ) : null}

            {isLocation ? (
              <TouchableOpacity
                style={[styles.attachCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                onPress={geoCoords ? () => openMaps(geoCoords) : undefined}
                activeOpacity={geoCoords ? 0.7 : 1}
                disabled={!geoCoords}
              >
                <View style={[styles.attachAvatar, { backgroundColor: colors.danger + "22" }]}>
                  <Feather name="map-pin" size={20} color={colors.danger} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.attachTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {(item.content ?? "").replace(/^📍\s*/, "").trim() || "Lokasi"}
                  </Text>
                  <Text style={[styles.fileMeta, { color: colors.mutedForeground }]}>
                    {geoCoords ? "Buka di peta" : "Lokasi dibagikan"}
                  </Text>
                </View>
                {geoCoords ? <Feather name="external-link" size={16} color={colors.mutedForeground} /> : null}
              </TouchableOpacity>
            ) : null}

            {link ? <LinkPreviewCard url={link} isOutbound={out} /> : null}
            {item.content && !isContact && !isLocation ? (
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
              {out ? (
                item.status === "read" ? (
                  <MaterialCommunityIcons
                    name="check-all"
                    size={14}
                    color={colors.tickRead}
                    accessibilityLabel="Dibaca"
                  />
                ) : item.status === "delivered" ? (
                  <MaterialCommunityIcons
                    name="check-all"
                    size={14}
                    color={colors.mutedForeground}
                    accessibilityLabel="Terkirim"
                  />
                ) : (
                  <MaterialCommunityIcons
                    name="check"
                    size={14}
                    color={colors.mutedForeground}
                    accessibilityLabel="Terkirim ke server"
                  />
                )
              ) : null}
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
    <View style={[styles.container, { backgroundColor: chatBg }]}>
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
            <TouchableOpacity
              onPress={() => chat?.profilePicUrl && setPhotoOpen(true)}
              disabled={!chat?.profilePicUrl}
              activeOpacity={0.8}
            >
              <Avatar name={chat?.contactName || "?"} uri={chat?.profilePicUrl} size={38} />
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex: 1 }}
              activeOpacity={0.7}
              onPress={() => {
                setInfoTab("info");
                setInfoOpen(true);
              }}
            >
              <Text
                style={[styles.headerName, { color: colors.headerForeground }]}
                numberOfLines={1}
              >
                {chat?.nickname || chat?.contactName || "Memuat..."}
              </Text>
              {presenceLabel(chat?.presence) ? (
                <Text style={styles.headerSub} numberOfLines={1}>
                  {presenceLabel(chat?.presence)}
                </Text>
              ) : chat?.phoneNumber ? (
                <Text style={styles.headerSub} numberOfLines={1}>
                  {chat.phoneNumber}
                </Text>
              ) : null}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setSearchOpen((v) => !v);
                setSearchQuery("");
              }}
              style={styles.backBtn}
            >
              <Feather name="search" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setLabelModal(true)} style={styles.backBtn}>
              <Feather name="tag" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.backBtn}>
              <Feather name="more-vertical" size={20} color={colors.headerForeground} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* In-chat search */}
      {searchOpen ? (
        <View style={[styles.searchBar, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
          <View style={[styles.searchBox, { backgroundColor: colors.secondary }]}>
            <Feather name="search" size={18} color={colors.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              placeholder="Cari di chat ini"
              placeholderTextColor={colors.mutedForeground}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

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
            data={visibleMessages}
            inverted
            keyExtractor={(m) => String(m.id)}
            renderItem={renderMessage}
            contentContainerStyle={styles.messages}
            removeClippedSubviews
            initialNumToRender={15}
            maxToRenderPerBatch={12}
            windowSize={9}
            ListEmptyComponent={
              searchOpen && searchQuery.trim() ? (
                <View style={[styles.center, { transform: [{ scaleY: -1 }] }]}>
                  <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                    Tidak ada pesan yang cocok.
                  </Text>
                </View>
              ) : null
            }
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

        {/* Quick chips — open the info panel at the relevant tab */}
        {!editTarget && !recording ? (
          <View style={[styles.quickRow, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={[styles.quickChip, { backgroundColor: colors.secondary }]}
              onPress={insertAlamat}
            >
              <Feather name="map-pin" size={13} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.foreground }]}>/almt</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.quickChip, { backgroundColor: colors.secondary }]}
              onPress={() => openPanel("shortcut")}
            >
              <Feather name="zap" size={13} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.foreground }]}>Pesan Cepat</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.quickChip, { backgroundColor: colors.secondary }]}
              onPress={() => openPanel("produk")}
            >
              <Feather name="box" size={13} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.foreground }]}>Kirim Produk</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.quickChip, { backgroundColor: colors.secondary }]}
              onPress={() => openPanel("order")}
            >
              <Feather name="shopping-cart" size={13} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.foreground }]}>Buat Order</Text>
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
          {recording ? (
            <VoiceRecorder onSend={onSendVoiceNote} onCancel={() => setRecording(false)} />
          ) : (
            <>
              {!editTarget ? (
                <TouchableOpacity onPress={() => setAttachOpen(true)} style={styles.attachBtn}>
                  <Feather name="plus-circle" size={24} color={colors.mutedForeground} />
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
              {!editTarget && !text.trim() ? (
                <TouchableOpacity
                  onPress={() => setRecording(true)}
                  disabled={sending}
                  style={[styles.sendBtn, { backgroundColor: colors.primary }]}
                  accessibilityLabel="Rekam pesan suara"
                >
                  <Feather name="mic" size={20} color="#fff" />
                </TouchableOpacity>
              ) : (
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
              )}
            </>
          )}
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

      {/* Attachment sheet (＋) */}
      <Modal
        visible={attachOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAttachOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)}>
          <Pressable
            style={[
              styles.attachSheet,
              { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 },
            ]}
          >
            <View style={styles.attachGrid}>
              <AttachOption icon="image" label="Galeri" color="#2F6DF0" onPress={onPickGallery} />
              <AttachOption icon="camera" label="Kamera" color="#E0503A" onPress={onPickCamera} />
              <AttachOption icon="file-text" label="Dokumen" color="#7C3AED" onPress={onPickDocument} />
              <AttachOption icon="map-pin" label="Lokasi" color="#1F9D6B" onPress={onSendLocation} />
              <AttachOption icon="user" label="Kontak" color="#E8941F" onPress={onPickContact} />
              <AttachOption
                icon="box"
                label="Produk"
                color={colors.primary}
                onPress={() => {
                  setAttachOpen(false);
                  openPanel("produk");
                }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Overflow (⋮) menu */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={[styles.menuSheet, { backgroundColor: colors.card }]}>
            <ActionRow
              icon="user"
              label="Lihat Foto Profil"
              color={colors.foreground}
              onPress={() => {
                setMenuOpen(false);
                if (chat?.profilePicUrl) setPhotoOpen(true);
                else Alert.alert("Tidak ada foto profil.");
              }}
            />
            <ActionRow
              icon="search"
              label="Cari di Chat"
              color={colors.foreground}
              onPress={() => {
                setMenuOpen(false);
                setSearchOpen(true);
                setSearchQuery("");
              }}
            />
            <ActionRow
              icon="star"
              label="Pesan Berbintang"
              color={colors.foreground}
              onPress={() => {
                setMenuOpen(false);
                setStarredOpen(true);
              }}
            />
            <ActionRow
              icon="share-2"
              label="Ekspor Chat"
              color={colors.foreground}
              onPress={onExportChat}
            />
            <ActionRow
              icon={
                chat?.mutedUntil && new Date(chat.mutedUntil) > new Date()
                  ? "bell"
                  : "bell-off"
              }
              label={
                chat?.mutedUntil && new Date(chat.mutedUntil) > new Date()
                  ? "Bunyikan"
                  : "Bisukan"
              }
              color={colors.foreground}
              onPress={onToggleMute}
            />
            {!chat?.phoneNumber?.endsWith("@g.us") ? (
              <ActionRow
                icon="slash"
                label={chat?.isBlocked ? "Buka Blokir" : "Blokir Kontak"}
                color={colors.destructive}
                onPress={onToggleBlock}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Starred messages */}
      <Modal
        visible={starredOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setStarredOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setStarredOpen(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card, maxHeight: "75%" }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Pesan Berbintang
            </Text>
            {starredLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
            ) : (starred?.messages ?? []).length === 0 ? (
              <Text style={[styles.muted, { color: colors.mutedForeground }]}>
                Belum ada pesan berbintang.
              </Text>
            ) : (
              <FlatList
                data={starred?.messages ?? []}
                keyExtractor={(m) => String(m.id)}
                renderItem={({ item }) => (
                  <View style={[styles.starredRow, { borderBottomColor: colors.border }]}>
                    <Feather name="star" size={14} color={colors.warning} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.starredMeta, { color: colors.mutedForeground }]}>
                        {item.direction === "outbound"
                          ? user?.name || "Saya"
                          : item.senderName || chat?.contactName || "Kontak"}{" "}
                        · {msgTime(item.createdAt)}
                      </Text>
                      <Text style={[styles.starredText, { color: colors.foreground }]} numberOfLines={4}>
                        {item.content || "[media]"}
                      </Text>
                    </View>
                  </View>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <ImageLightbox
        uri={photoOpen ? resolveMediaUrl(chat?.profilePicUrl) : null}
        title={chat?.nickname || chat?.contactName}
        onClose={() => setPhotoOpen(false)}
      />

      {/* Lightbox untuk foto di dalam percakapan (ketuk gambar bubble). */}
      <ImageLightbox
        uri={imageView}
        onClose={() => setImageView(null)}
      />

      <ChatInfoPanel
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        chatId={chatId}
        chat={chat}
        initialTab={infoTab}
      />
    </View>
  );
}

function AttachOption({
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
  const colors = useColors();
  return (
    <TouchableOpacity style={styles.attachOption} onPress={onPress}>
      <View style={[styles.attachIcon, { backgroundColor: color + "22" }]}>
        <Feather name={icon} size={24} color={color} />
      </View>
      <Text style={[styles.attachLabel, { color: colors.foreground }]}>{label}</Text>
    </TouchableOpacity>
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
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
    minWidth: 200,
  },
  fileName: { fontFamily: "Inter_500Medium", fontSize: 14 },
  fileMeta: { fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 1 },
  attachCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
    minWidth: 200,
  },
  attachAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  attachTitle: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
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
  emptyText: { fontFamily: "Inter_400Regular", fontSize: 14, textAlign: "center" },
  searchBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 15, padding: 0 },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  quickChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  quickText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  attachSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  attachGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 24,
    rowGap: 18,
    paddingBottom: 4,
  },
  attachOption: { alignItems: "center", gap: 8, width: 64 },
  attachIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  attachLabel: { fontFamily: "Inter_500Medium", fontSize: 13 },
  menuSheet: {
    position: "absolute",
    top: 70,
    right: 12,
    borderRadius: 14,
    paddingVertical: 6,
    minWidth: 220,
    overflow: "hidden",
  },
  starredRow: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  starredMeta: { fontFamily: "Inter_500Medium", fontSize: 12, marginBottom: 3 },
  starredText: { fontFamily: "Inter_400Regular", fontSize: 14 },
});
