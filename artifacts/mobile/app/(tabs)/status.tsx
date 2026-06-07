import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useListStatuses,
  usePostStatus,
  getListStatusesQueryKey,
  type WhatsappStatus2,
  type WhatsappStatusAuthor,
} from "@workspace/api-client-react";

import { Avatar } from "@/components/Avatar";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl, uploadImageStatus } from "@/lib/api";

const BG_COLORS = [
  "#128c7e",
  "#075e54",
  "#5b2c6f",
  "#1f6feb",
  "#b91c1c",
  "#b45309",
  "#0f766e",
  "#1f2937",
];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Baru saja";
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hr lalu`;
}

export default function StatusScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { activeChannelId } = useChannel();

  const {
    data: authors,
    isLoading,
    isRefetching,
    refetch,
  } = useListStatuses({
    query: {
      queryKey: getListStatusesQueryKey(),
      enabled: activeChannelId != null,
      refetchInterval: 15000,
    },
  });

  const postStatus = usePostStatus();

  const [composeOpen, setComposeOpen] = useState(false);
  const [text, setText] = useState("");
  const [bg, setBg] = useState(BG_COLORS[0]);
  const [posting, setPosting] = useState(false);
  const [viewer, setViewer] = useState<WhatsappStatusAuthor | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListStatusesQueryKey() });

  const mine = authors?.find((a) => a.isMine) ?? null;
  const others = authors?.filter((a) => !a.isMine) ?? [];

  const submitText = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    try {
      await postStatus.mutateAsync({
        data: { text: text.trim(), backgroundColor: bg },
      });
      setText("");
      setComposeOpen(false);
      invalidate();
    } catch {
      // keep dialog open on failure
    } finally {
      setPosting(false);
    }
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    setPosting(true);
    try {
      await uploadImageStatus(
        {
          uri: asset.uri,
          name: asset.fileName || `status-${Date.now()}.jpg`,
          type: asset.mimeType || "image/jpeg",
        },
        "",
      );
      setComposeOpen(false);
      invalidate();
    } catch {
      // ignore
    } finally {
      setPosting(false);
    }
  };

  const renderAuthor = (author: WhatsappStatusAuthor) => (
    <TouchableOpacity
      key={author.authorJid}
      style={styles.authorRow}
      activeOpacity={0.6}
      onPress={() => setViewer(author)}
    >
      <View
        style={[styles.ring, { borderColor: colors.accent }]}
      >
        <Avatar name={author.authorName} uri={author.profilePicUrl} size={52} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.authorName, { color: colors.foreground }]}>
          {author.isMine ? "Status Saya" : author.authorName}
        </Text>
        <Text style={[styles.authorSub, { color: colors.mutedForeground }]}>
          {author.statuses.length} pembaruan ·{" "}
          {timeAgo(author.statuses[0]?.postedAt ?? new Date().toISOString())}
        </Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.header },
        ]}
      >
        <Text style={[styles.headerTitle, { color: colors.headerForeground }]}>
          Status
        </Text>
        <ChannelSwitcher />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={others}
          keyExtractor={(a) => a.authorJid}
          renderItem={({ item }) => renderAuthor(item)}
          contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <View>
              {mine ? (
                renderAuthor(mine)
              ) : (
                <View style={styles.authorRow}>
                  <View
                    style={[
                      styles.ring,
                      { borderColor: colors.border, borderStyle: "dashed" },
                    ]}
                  >
                    <Avatar name="Status Saya" size={52} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[styles.authorName, { color: colors.foreground }]}
                    >
                      Status Saya
                    </Text>
                    <Text
                      style={[styles.authorSub, { color: colors.mutedForeground }]}
                    >
                      Ketuk tombol + untuk membuat status
                    </Text>
                  </View>
                </View>
              )}
              {others.length > 0 ? (
                <Text
                  style={[styles.sectionTitle, { color: colors.mutedForeground }]}
                >
                  PEMBARUAN TERKINI
                </Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            !mine ? (
              <View style={styles.center}>
                <Text
                  style={[styles.emptyText, { color: colors.mutedForeground }]}
                >
                  Belum ada status.
                </Text>
              </View>
            ) : null
          }
        />
      )}

      <TouchableOpacity
        style={[
          styles.fab,
          { backgroundColor: colors.primary, bottom: insets.bottom + 80 },
        ]}
        onPress={() => setComposeOpen(true)}
        activeOpacity={0.85}
      >
        <Feather name="plus" size={26} color="#ffffff" />
      </TouchableOpacity>

      {/* Compose modal */}
      <Modal
        visible={composeOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setComposeOpen(false)}
      >
        <View style={styles.composeBackdrop}>
          <View
            style={[styles.composeSheet, { backgroundColor: colors.card }]}
          >
            <View style={styles.composeHeader}>
              <Text style={[styles.composeTitle, { color: colors.foreground }]}>
                Buat Status
              </Text>
              <TouchableOpacity onPress={() => setComposeOpen(false)}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={[styles.preview, { backgroundColor: bg }]}>
              <TextInput
                style={styles.previewInput}
                placeholder="Ketik status..."
                placeholderTextColor="rgba(255,255,255,0.7)"
                value={text}
                onChangeText={setText}
                multiline
                maxLength={700}
              />
            </View>

            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={BG_COLORS}
              keyExtractor={(c) => c}
              style={{ flexGrow: 0, marginTop: 12 }}
              contentContainerStyle={{ gap: 10, paddingHorizontal: 4 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => setBg(item)}
                  style={[
                    styles.swatch,
                    { backgroundColor: item },
                    bg === item && styles.swatchActive,
                  ]}
                />
              )}
            />

            <View style={styles.composeActions}>
              <TouchableOpacity
                style={[styles.imageBtn, { borderColor: colors.border }]}
                onPress={pickImage}
                disabled={posting}
              >
                <Feather name="image" size={20} color={colors.primary} />
                <Text style={[styles.imageBtnText, { color: colors.primary }]}>
                  Gambar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.postBtn,
                  { backgroundColor: colors.primary },
                  (!text.trim() || posting) && { opacity: 0.5 },
                ]}
                onPress={submitText}
                disabled={!text.trim() || posting}
              >
                {posting ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.postBtnText}>Kirim teks</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Viewer modal */}
      <StatusViewer author={viewer} onClose={() => setViewer(null)} />
    </View>
  );
}

function StatusViewer({
  author,
  onClose,
}: {
  author: WhatsappStatusAuthor | null;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const list = author?.statuses ?? [];
  const current: WhatsappStatus2 | undefined = list[index];

  React.useEffect(() => {
    setIndex(0);
  }, [author?.authorJid]);

  if (!author || !current) return null;

  const next = () => {
    if (index < list.length - 1) setIndex((i) => i + 1);
    else onClose();
  };
  const prev = () => {
    if (index > 0) setIndex((i) => i - 1);
  };

  const mediaUri = resolveMediaUrl(current.mediaUrl);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerRoot}>
        <View style={styles.progressRow}>
          {list.map((_, i) => (
            <View key={i} style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: i <= index ? "100%" : "0%" },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.viewerHeader}>
          <Avatar name={author.authorName} uri={author.profilePicUrl} size={36} />
          <Text style={styles.viewerName}>
            {author.isMine ? "Status Saya" : author.authorName}
          </Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
            <Feather name="x" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={styles.viewerBody}>
          {current.statusType === "image" && mediaUri ? (
            <Image
              source={{ uri: mediaUri }}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          ) : (
            <View
              style={[
                styles.viewerText,
                { backgroundColor: current.backgroundColor || "#128c7e" },
              ]}
            >
              <Text style={styles.viewerTextContent}>
                {current.textContent}
              </Text>
            </View>
          )}
          {current.caption ? (
            <Text style={styles.viewerCaption}>{current.caption}</Text>
          ) : null}
        </View>

        <Pressable style={styles.tapLeft} onPress={prev} />
        <Pressable style={styles.tapRight} onPress={next} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyText: { fontFamily: "Inter_400Regular", fontSize: 15 },
  authorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ring: {
    padding: 2,
    borderRadius: 30,
    borderWidth: 2,
  },
  authorName: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  authorSub: { fontFamily: "Inter_400Regular", fontSize: 13, marginTop: 2 },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  fab: {
    position: "absolute",
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  composeBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  composeSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  composeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  composeTitle: { fontFamily: "Inter_700Bold", fontSize: 18 },
  preview: {
    minHeight: 160,
    borderRadius: 14,
    padding: 16,
    justifyContent: "center",
  },
  previewInput: {
    color: "#ffffff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 22,
    textAlign: "center",
  },
  swatch: { width: 36, height: 36, borderRadius: 18 },
  swatchActive: { borderWidth: 3, borderColor: "#ffffff" },
  composeActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
    alignItems: "center",
  },
  imageBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
  },
  imageBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  postBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  postBtnText: { color: "#ffffff", fontFamily: "Inter_600SemiBold", fontSize: 15 },
  viewerRoot: { flex: 1, backgroundColor: "#000" },
  progressRow: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 50,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden",
  },
  progressFill: { height: 3, backgroundColor: "#fff" },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
  },
  viewerName: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 16, flex: 1 },
  viewerBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  viewerImage: { width: "100%", height: "80%" },
  viewerText: {
    width: "100%",
    aspectRatio: 1,
    maxHeight: "80%",
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  viewerTextContent: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 26,
    textAlign: "center",
  },
  viewerCaption: {
    color: "#fff",
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    marginTop: 16,
    textAlign: "center",
  },
  tapLeft: { position: "absolute", left: 0, top: 100, bottom: 0, width: "30%" },
  tapRight: { position: "absolute", right: 0, top: 100, bottom: 0, width: "70%" },
});
