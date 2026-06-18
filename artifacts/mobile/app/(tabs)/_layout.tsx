import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";
import {
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

/**
 * Raised, circular center button for the Chat tab. Chat is where ~90% of an
 * agent's work happens, so it sits in the middle of the bar and floats above
 * the chrome (WhatsApp-style FAB feel).
 */
function CenterChatButton({
  onPress,
  accessibilityState,
}: {
  onPress?: (e: GestureResponderEvent) => void;
  accessibilityState?: { selected?: boolean };
}) {
  const colors = useColors();
  const focused = accessibilityState?.selected;
  return (
    <View style={styles.centerWrap} pointerEvents="box-none">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Chat"
        style={[
          styles.centerBtn,
          {
            backgroundColor: colors.primary,
            borderColor: colors.background,
            shadowColor: colors.primaryDark,
          },
        ]}
      >
        <Feather name="message-circle" size={26} color={colors.primaryForeground} />
      </Pressable>
      <Text
        style={[
          styles.centerLabel,
          { color: focused ? colors.primary : colors.mutedForeground },
        ]}
      >
        Chat
      </Text>
    </View>
  );
}

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarLabelStyle: { fontFamily: "Inter_500Medium", fontSize: 10 },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + 4,
          paddingTop: 6,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Feather name="grid" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="produk"
        options={{
          title: "Produk",
          tabBarIcon: ({ color, size }) => (
            <Feather name="box" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: "Chat",
          tabBarButton: (props) => (
            <CenterChatButton
              onPress={props.onPress ?? undefined}
              accessibilityState={props.accessibilityState}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="workboard"
        options={{
          title: "Workboard",
          tabBarIcon: ({ color, size }) => (
            <Feather name="columns" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Setting",
          tabBarIcon: ({ color, size }) => (
            <Feather name="settings" size={size ?? 22} color={color} />
          ),
        }}
      />
      {/* Status (story) is no longer a bottom tab in v5 — it was replaced by
          Produk. It stays a navigable route, reached from the Chat header. */}
      <Tabs.Screen name="status" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  centerBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -22,
    borderWidth: 4,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
  },
  centerLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    marginTop: 2,
  },
});
