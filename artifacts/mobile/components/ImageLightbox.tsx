import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Fullscreen image viewer used for profile photos and any tappable picture
 * (§7). Tap anywhere or the close button to dismiss. `title` shows a caption
 * bar at the bottom (e.g. the contact's name).
 */
export function ImageLightbox({
  uri,
  title,
  onClose,
}: {
  uri: string | null;
  title?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={!!uri}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.root} onPress={onClose}>
        {uri ? (
          <Image source={{ uri }} style={styles.img} resizeMode="contain" />
        ) : null}
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={[styles.close, { top: insets.top + 12 }]}
        >
          <Feather name="x" size={28} color="#fff" />
        </Pressable>
        {title ? (
          <View style={[styles.caption, { paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.captionText} numberOfLines={1}>
              {title}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  img: { width: "100%", height: "100%" },
  close: { position: "absolute", right: 16 },
  caption: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
  captionText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 16 },
});
