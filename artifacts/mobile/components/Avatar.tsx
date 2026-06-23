import { Image } from "expo-image";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl } from "@/lib/api";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(seed: string, palette: string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

const SEED_COLORS = [
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
];

function AvatarBase({
  name,
  uri,
  size = 48,
}: {
  name: string;
  uri?: string | null;
  size?: number;
}) {
  const colors = useColors();
  const resolved = resolveMediaUrl(uri ?? null);
  const bg = colorFor(name || "?", SEED_COLORS);

  if (resolved) {
    return (
      <Image
        source={{ uri: resolved }}
        // Recycle the decoded bitmap by contact url so scrolling a long list
        // reuses cached images instead of re-decoding/popping-in on each pass.
        recyclingKey={resolved}
        cachePolicy="memory-disk"
        transition={120}
        contentFit="cover"
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.muted,
        }}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>
        {initials(name || "?")}
      </Text>
    </View>
  );
}

// Memoized: avatars sit inside long lists; re-rendering them on every poll is
// pure waste when name/uri/size are unchanged.
export const Avatar = React.memo(AvatarBase);

const styles = StyleSheet.create({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: "#ffffff",
    fontFamily: "Inter_600SemiBold",
  },
});
