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

export function ChannelSwitcher({ tint }: { tint?: string }) {
  const colors = useColors();
  const { channels, activeChannel, activeChannelId, setActiveChannelId } =
    useChannel();
  const [open, setOpen] = useState(false);
  const color = tint ?? colors.headerForeground;

  return (
    <>
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <View
          style={[
            styles.dot,
            { backgroundColor: activeChannel?.color ?? colors.accent },
          ]}
        />
        <Text style={[styles.triggerLabel, { color }]} numberOfLines={1}>
          {activeChannel?.label ?? "Pilih channel"}
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
              channels.map((c) => {
                const active = c.id === activeChannelId;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={[
                      styles.row,
                      active && { backgroundColor: colors.secondary },
                    ]}
                    onPress={() => {
                      setActiveChannelId(c.id);
                      setOpen(false);
                    }}
                  >
                    <Feather
                      name={KIND_ICON[c.kind] ?? "hash"}
                      size={18}
                      color={c.color || colors.primary}
                    />
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
                      ) : null}
                    </View>
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
  rowLabel: { fontFamily: "Inter_500Medium", fontSize: 15 },
  rowSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  empty: { fontFamily: "Inter_400Regular", fontSize: 14, padding: 12 },
});
