import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Chat } from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { InfoTab } from "./InfoTab";
import { MediaTab } from "./MediaTab";
import { OrderTab } from "./OrderTab";
import { ProdukTab } from "./ProdukTab";
import { ShortcutTab } from "./ShortcutTab";

type TabKey = "info" | "media" | "shortcut" | "produk" | "order";

const TABS: {
  key: TabKey;
  label: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { key: "info", label: "Info", icon: "info" },
  { key: "media", label: "Media", icon: "image" },
  { key: "shortcut", label: "Shortcut", icon: "zap" },
  { key: "produk", label: "Produk", icon: "box" },
  { key: "order", label: "Order", icon: "shopping-cart" },
];

export function ChatInfoPanel({
  visible,
  onClose,
  chatId,
  chat,
}: {
  visible: boolean;
  onClose: () => void;
  chatId: number;
  chat: Chat | undefined;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(width * 0.92, 520);
  const tx = useRef(new Animated.Value(panelWidth)).current;
  const [tab, setTab] = useState<TabKey>("info");

  useEffect(() => {
    Animated.timing(tx, {
      toValue: visible ? 0 : panelWidth,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [visible, panelWidth, tx]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <Animated.View
          style={[
            styles.panel,
            {
              width: panelWidth,
              transform: [{ translateX: tx }],
              backgroundColor: colors.background,
              paddingTop: insets.top,
            },
          ]}
        >
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text
              style={[styles.title, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {chat?.nickname || chat?.contactName || "Info"}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          {/* Tab bar */}
          <View style={[styles.tabBarWrap, { borderBottomColor: colors.border }]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabBar}
            >
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    onPress={() => setTab(t.key)}
                    style={[
                      styles.tab,
                      {
                        backgroundColor: active
                          ? colors.primary
                          : colors.secondary,
                      },
                    ]}
                  >
                    <Feather
                      name={t.icon}
                      size={14}
                      color={
                        active ? colors.primaryForeground : colors.mutedForeground
                      }
                    />
                    <Text
                      style={[
                        styles.tabText,
                        {
                          color: active
                            ? colors.primaryForeground
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Content */}
          <View style={{ flex: 1 }}>
            {!chat ? null : tab === "info" ? (
              <InfoTab chatId={chatId} chat={chat} />
            ) : tab === "media" ? (
              <MediaTab chatId={chatId} />
            ) : tab === "shortcut" ? (
              <ShortcutTab chatId={chatId} onSent={onClose} />
            ) : tab === "produk" ? (
              <ProdukTab chatId={chatId} onSent={onClose} />
            ) : (
              <OrderTab chatId={chatId} chat={chat} onSent={onClose} />
            )}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  panel: {
    height: "100%",
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 17 },
  closeBtn: { padding: 4 },
  tabBarWrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  tabBar: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  tabText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
