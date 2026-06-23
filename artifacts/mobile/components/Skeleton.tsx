import React, { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";

/**
 * Reusable shimmer placeholder. Animates **only `opacity`** on a single shared
 * value (driven on the UI thread by Reanimated) so it never causes layout work
 * or JS-thread jank while a screen is loading. Every block on screen shares the
 * same pulse phase, which reads as one cohesive "loading" surface.
 */
export function Skeleton({
  width,
  height = 14,
  radius = 8,
  style,
}: {
  width?: ViewStyle["width"];
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const colors = useColors();
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 750, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      style={[
        {
          width: width ?? "100%",
          height,
          borderRadius: radius,
          backgroundColor: colors.muted,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** A single chat-list row skeleton (avatar + two text lines + a pill). */
function ChatRowSkeleton() {
  return (
    <View style={styles.chatRow}>
      <Skeleton width={52} height={52} radius={26} />
      <View style={styles.chatBody}>
        <View style={styles.chatTop}>
          <Skeleton width="55%" height={15} />
          <Skeleton width={34} height={11} />
        </View>
        <Skeleton width="80%" height={13} />
        <Skeleton width={90} height={16} radius={10} />
      </View>
    </View>
  );
}

/** Full-screen list of chat-row skeletons shown on initial load. */
export function ChatListSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <View style={styles.fill}>
      {Array.from({ length: rows }).map((_, i) => (
        <ChatRowSkeleton key={i} />
      ))}
    </View>
  );
}

/** A single product-card skeleton (thumb + text + badge). */
function ProductRowSkeleton() {
  return (
    <View style={styles.prodCard}>
      <Skeleton width={60} height={60} radius={10} />
      <View style={styles.prodBody}>
        <Skeleton width="70%" height={14} />
        <Skeleton width="40%" height={12} />
        <Skeleton width={70} height={15} />
      </View>
      <Skeleton width={30} height={22} radius={10} />
    </View>
  );
}

export function ProductListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <View style={styles.prodFill}>
      {Array.from({ length: rows }).map((_, i) => (
        <ProductRowSkeleton key={i} />
      ))}
    </View>
  );
}

/** A single WorkBoard card skeleton. */
function CardSkeleton() {
  return (
    <View style={styles.wbCard}>
      <Skeleton width="60%" height={15} />
      <Skeleton width={90} height={14} />
      <Skeleton width="40%" height={12} />
    </View>
  );
}

export function WorkboardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <View style={styles.wbFill}>
      {Array.from({ length: rows }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { paddingTop: 4 },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  chatBody: { flex: 1, gap: 7 },
  chatTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  prodFill: { padding: 12, gap: 8 },
  prodCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 14,
  },
  prodBody: { flex: 1, gap: 8 },
  wbFill: { padding: 12, gap: 10 },
  wbCard: { borderRadius: 14, padding: 12, gap: 8 },
});
