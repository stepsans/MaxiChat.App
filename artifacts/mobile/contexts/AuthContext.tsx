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
  logout as apiLogout,
  getMe,
  registerPushToken,
  unregisterPushToken,
  type AuthUser,
} from "@workspace/api-client-react";

import {
  loadStoredToken,
  loadTrustedToken,
  persistToken,
  persistTrustedToken,
  mobileLoginWithDevice,
  setMemToken,
  setMemChannelId,
  setUnauthorizedCallback,
  type MobileSessionResult,
} from "@/lib/api";
import { registerForPushNotificationsAsync } from "@/lib/push";

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  /** Verify the emailed OTP and establish a mobile session. */
  signIn: (email: string, otp: string) => Promise<void>;
  /** Apply a ready session from the trusted-device fast-path (no OTP). */
  completeTrustedLogin: (session: MobileSessionResult) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
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
      await loadTrustedToken(); // make the trusted-device token available to login
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

  // Persist a session (token + optional trusted-device token) and set state.
  const establishSession = useCallback(async (session: MobileSessionResult) => {
    await persistToken(session.token);
    setMemToken(session.token);
    if (session.trustedDeviceToken) await persistTrustedToken(session.trustedDeviceToken);
    setToken(session.token);
    setUser(session.user);
  }, []);

  const signIn = useCallback(async (email: string, otp: string) => {
    const session = await mobileLoginWithDevice(email, otp);
    await establishSession(session);
  }, [establishSession]);

  const completeTrustedLogin = useCallback(async (session: MobileSessionResult) => {
    await establishSession(session);
  }, [establishSession]);

  // Reset auth state when the API client reports a mid-session 401 (the token
  // was already cleared in lib/api). The `!!token` route guard then bounces to
  // the login screen.
  useEffect(() => {
    setUnauthorizedCallback(() => {
      setToken(null);
      setUser(null);
    });
    return () => setUnauthorizedCallback(null);
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
    await persistTrustedToken(null); // explicit logout forgets the device
    setMemToken(null);
    setMemChannelId(null);
    setToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await getMe();
      if (me?.user) setUser(me.user);
    } catch {
      // ignore — keep the cached user on a transient failure
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, isLoading, signIn, completeTrustedLogin, signOut, refreshUser }),
    [user, token, isLoading, signIn, completeTrustedLogin, signOut, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
