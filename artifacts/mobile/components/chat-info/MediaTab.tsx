import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useGetChatAttachments,
  useGetStarredMessages,
  getGetChatAttachmentsQueryKey,
  getGetStarredMessagesQueryKey,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl } from "@/lib/api";
import { shortDateTime } from "./shared";

type SubTab = "media" | "docs" | "links" | "starred";

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "media", label: "Media" },
  { key: "docs", label: "Dokumen" },
  { key: "links", label: "Link" },
  { key: "starred", label: "Berbintang" },
];

export function MediaTab({ chatId }: { chatId: number }) {
  const colors = useColors();
  const [sub, setSub] = useState<SubTab>("media");

  const { data: attachments } = useGetChatAttachments(chatId, {
    query: {
      queryKey: getGetChatAttachmentsQueryKey(chatId),
      enabled: Number.isFinite(chatId),
    },
  });
  const { data: starred } = useGetStarredMessages(chatId, {
    query: {
      queryKey: getGetStarredMessagesQueryKey(chatId),
      enabled: Number.isFinite(chatId) && sub === "starred",
    },
  });

  const open = (url: string | null | undefined) => {
    const resolved = resolveMediaUrl(url);
    if (resolved) Linking.openURL(resolved).catch(() => undefined);
  };

  const media = attachments?.media ?? [];
  const docs = attachments?.docs ?? [];
  const links = attachments?.links ?? [];

  return (
    <View style={{ flex: 1 }}>
      {/* Sub-tab bar */}
      <View style={[styles.subBar, { borderBottomColor: colors.border }]}>
        {SUBTABS.map((s) => {
          const active = sub === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              onPress={() => setSub(s.key)}
              style={[
                styles.subTab,
                active && { borderBottomColor: colors.primary },
              ]}
            >
              <Text
                style={[
                  styles.subTabText,
                  { color: active ? colors.primary : colors.mutedForeground },
                ]}
              >
                {s.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {sub === "media" ? (
          media.length === 0 ? (
            <Empty text="Belum ada media." />
          ) : (
            <View style={styles.grid}>
              {media.map((m) => {
                const isImage =
                  m.mediaType === "image" ||
                  m.mediaMimeType?.startsWith("image/");
                const uri = isImage ? resolveMediaUrl(m.mediaUrl) : null;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.thumb, { backgroundColor: colors.muted }]}
                    onPress={() => open(m.mediaUrl)}
                  >
                    {uri ? (
                      <Image source={{ uri }} style={styles.thumbImg} />
                    ) : (
                      <Feather
                        name="film"
                        size={22}
                        color={colors.mutedForeground}
                      />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )
        ) : null}

        {sub === "docs" ? (
          docs.length === 0 ? (
            <Empty text="Belum ada dokumen." />
          ) : (
            docs.map((d) => (
              <TouchableOpacity
                key={d.id}
                style={[styles.rowItem, { borderColor: colors.border }]}
                onPress={() => open(d.mediaUrl)}
              >
                <Feather name="file-text" size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={[styles.rowTitle, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {d.mediaFilename || d.content || "Dokumen"}
                  </Text>
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                    {shortDateTime(d.createdAt)}
                  </Text>
                </View>
                <Feather
                  name="download"
                  size={16}
                  color={colors.mutedForeground}
                />
              </TouchableOpacity>
            ))
          )
        ) : null}

        {sub === "links" ? (
          links.length === 0 ? (
            <Empty text="Belum ada link." />
          ) : (
            links.map((l, i) => (
              <TouchableOpacity
                key={`${l.messageId}-${i}`}
                style={[styles.rowItem, { borderColor: colors.border }]}
                onPress={() => Linking.openURL(l.url).catch(() => undefined)}
              >
                <Feather name="link" size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={[styles.rowTitle, { color: colors.primary }]}
                    numberOfLines={1}
                  >
                    {l.url}
                  </Text>
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                    {shortDateTime(l.createdAt)}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )
        ) : null}

        {sub === "starred" ? (
          (starred?.messages ?? []).length === 0 ? (
            <Empty text="Belum ada pesan berbintang." />
          ) : (
            (starred?.messages ?? []).map((m) => (
              <View
                key={m.id}
                style={[styles.starItem, { borderColor: colors.border }]}
              >
                <Feather name="star" size={14} color="#f59e0b" />
                <View style={{ flex: 1 }}>
                  {m.senderName ? (
                    <Text style={[styles.rowSub, { color: colors.primary }]}>
                      {m.senderName}
                    </Text>
                  ) : null}
                  <Text style={[styles.starText, { color: colors.foreground }]}>
                    {m.content || "(media)"}
                  </Text>
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                    {shortDateTime(m.createdAt)}
                  </Text>
                </View>
              </View>
            ))
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text style={[styles.empty, { color: colors.mutedForeground }]}>{text}</Text>
  );
}

const styles = StyleSheet.create({
  subBar: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  subTabText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  body: { padding: 12, paddingBottom: 48 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  thumb: {
    width: "31.5%",
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImg: { width: "100%", height: "100%" },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontFamily: "Inter_500Medium", fontSize: 14 },
  rowSub: { fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 2 },
  starItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  starText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 19,
    marginTop: 2,
  },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
  },
});
