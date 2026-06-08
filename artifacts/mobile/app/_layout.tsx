import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ChannelProvider } from "@/contexts/ChannelContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { useColors } from "@/hooks/useColors";
import { configureApiClient } from "@/lib/api";
import { chatIdFromNotificationData } from "@/lib/push";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Wire the generated API client (base url + token + channel getters) once,
// outside React, before any request is made.
configureApiClient();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

function RootLayoutNav() {
  const { token, isLoading } = useAuth();
  const colors = useColors();
  const router = useRouter();

  // Open the relevant chat when the user taps a message notification (both a
  // cold start via the last response and warm taps via the listener).
  useEffect(() => {
    if (!token) return;
    let mounted = true;

    Notifications.getLastNotificationResponseAsync().then((resp) => {
      const chatId = chatIdFromNotificationData(
        resp?.notification.request.content.data,
      );
      if (mounted && chatId != null) router.push(`/chat/${chatId}`);
    });

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const chatId = chatIdFromNotificationData(
        resp.notification.request.content.data,
      );
      if (chatId != null) router.push(`/chat/${chatId}`);
    });

    return () => {
      mounted = false;
      sub.remove();
    };
  }, [token, router]);

  if (isLoading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!token}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[id]" />
      </Stack.Protected>
      <Stack.Protected guard={!token}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <ThemeProvider>
                <AuthProvider>
                  <ChannelProvider>
                    <RootLayoutNav />
                  </ChannelProvider>
                </AuthProvider>
              </ThemeProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
