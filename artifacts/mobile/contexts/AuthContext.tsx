import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import {
  mobileLogin,
  logout as apiLogout,
  getMe,
  registerPushToken,
  unregisterPushToken,
  type AuthUser,
} from "@workspace/api-client-react";

import {
  loadStoredToken,
  persistToken,
  setMemToken,
  setMemChannelId,
} from "@/lib/api";
import { registerForPushNotificationsAsync } from "@/lib/push";

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore a stored token on launch and validate it against /auth/me.
  useEffect(() => {
    let active = true;
    (async () => {
      const stored = await loadStoredToken();
      if (!stored) {
        if (active) setIsLoading(false);
        return;
      }
      setMemToken(stored);
      try {
        const me = await getMe();
        if (active && me?.user) {
          setUser(me.user);
          setToken(stored);
        } else if (active) {
          await persistToken(null);
        }
      } catch {
        if (active) await persistToken(null);
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Register for push notifications whenever we have an authenticated user.
  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      const expoToken = await registerForPushNotificationsAsync();
      if (active && expoToken) {
        try {
          const platform =
            Platform.OS === "ios"
              ? "ios"
              : Platform.OS === "android"
                ? "android"
                : "web";
          await registerPushToken({ token: expoToken, platform });
        } catch {
          // non-fatal — messaging still works without push
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [user]);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await mobileLogin({ email, password });
    await persistToken(session.token);
    setMemToken(session.token);
    setToken(session.token);
    setUser(session.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      const expoToken = await registerForPushNotificationsAsync();
      if (expoToken) await unregisterPushToken({ token: expoToken });
    } catch {
      // ignore
    }
    try {
      await apiLogout();
    } catch {
      // ignore — clear local state regardless
    }
    await persistToken(null);
    setMemToken(null);
    setMemChannelId(null);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, isLoading, signIn, signOut }),
    [user, token, isLoading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
