import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

const KIND_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  whatsapp: "message-circle",
  telegram: "send",
};

function isChannelConnected(status: string): boolean {
  return status === "connected" || status === "syncing";
}

export function ChannelSwitcher({ tint }: { tint?: string }) {
  const colors = useColors();
  const { channels, activeChannel, activeChannelId, setActiveChannelId } =
    useChannel();
  const [open, setOpen] = useState(false);
  const color = tint ?? colors.headerForeground;
  const isAll = activeChannelId === "all";

  const triggerLabel = isAll
    ? "Semua channel"
    : (activeChannel?.label ?? "Pilih channel");
  const triggerDotColor = isAll
    ? "#94a3b8"
    : (activeChannel?.color ?? colors.accent);

  return (
    <>
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <View style={[styles.dot, { backgroundColor: triggerDotColor }]} />
        <Text style={[styles.triggerLabel, { color }]} numberOfLines={1}>
          {triggerLabel}
        </Text>
        <Feather name="chevron-down" size={16} color={color} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.sheetTitle, { color: colors.mutedForeground }]}>
              CHANNEL
            </Text>
            {channels.length === 0 ? (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                Belum ada channel.
              </Text>
            ) : (
              <>
                {channels.map((c) => {
                  const active = c.id === activeChannelId;
                  const connected = isChannelConnected(c.status);
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={[
                        styles.row,
                        active && { backgroundColor: colors.secondary },
                        !connected && styles.rowDimmed,
                      ]}
                      onPress={() => {
                        setActiveChannelId(c.id);
                        setOpen(false);
                      }}
                    >
                      <View style={styles.iconWrapper}>
                        <Feather
                          name={KIND_ICON[c.kind] ?? "hash"}
                          size={18}
                          color={c.color || colors.primary}
                        />
                        {/* Connection status dot */}
                        <View
                          style={[
                            styles.statusDot,
                            {
                              backgroundColor: connected
                                ? "#22c55e"
                                : "#94a3b8",
                            },
                          ]}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowLabel, { color: colors.foreground }]}>
                          {c.label}
                        </Text>
                        {c.ownerPhone ? (
                          <Text
                            style={[styles.rowSub, { color: colors.mutedForeground }]}
                          >
                            {c.ownerPhone}
                          </Text>
                        ) : (
                          <Text
                            style={[styles.rowSub, { color: colors.mutedForeground }]}
                          >
                            {connected ? "Terhubung" : "Tidak terhubung"}
                          </Text>
                        )}
                      </View>
                      {active ? (
                        <Feather name="check" size={18} color={colors.primary} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })}

                {/* "All channels" option — only shown when there are 2+ channels */}
                {channels.length > 1 && (
                  <>
                    <View
                      style={[styles.separator, { backgroundColor: colors.border }]}
                    />
                    <TouchableOpacity
                      style={[
                        styles.row,
                        isAll && { backgroundColor: colors.secondary },
                      ]}
                      onPress={() => {
                        setActiveChannelId("all");
                        setOpen(false);
                      }}
                    >
                      <Feather
                        name="layers"
                        size={18}
                        color={colors.mutedForeground}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowLabel, { color: colors.foreground }]}>
                          Semua channel
                        </Text>
                        <Text
                          style={[styles.rowSub, { color: colors.mutedForeground }]}
                        >
                          Hanya channel terhubung
                        </Text>
                      </View>
                      {isAll ? (
                        <Feather name="check" size={18} color={colors.primary} />
                      ) : null}
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  triggerLabel: { fontFamily: "Inter_600SemiBold", fontSize: 16, flexShrink: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 2,
  },
  sheetTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  rowDimmed: { opacity: 0.55 },
  iconWrapper: { position: "relative" },
  statusDot: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.8)",
  },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  rowLabel: { fontFamily: "Inter_500Medium", fontSize: 15 },
  rowSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  empty: { fontFamily: "Inter_400Regular", fontSize: 14, padding: 12 },
});
