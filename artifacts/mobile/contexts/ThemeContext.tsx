import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedScheme = "light" | "dark";

const STORAGE_KEY = "maxichat.theme.pref";

interface ThemeContextValue {
  /** The user's chosen preference (light/dark/system). */
  preference: ThemePreference;
  /** The actual scheme to render (system resolves to the device setting). */
  scheme: ResolvedScheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const device = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  // Load the persisted preference once on mount.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (alive && (v === "light" || v === "dark" || v === "system")) {
          setPreferenceState(v);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setPreference = (pref: ThemePreference) => {
    setPreferenceState(pref);
    AsyncStorage.setItem(STORAGE_KEY, pref).catch(() => {});
  };

  const scheme: ResolvedScheme =
    preference === "system" ? (device === "dark" ? "dark" : "light") : preference;

  const value = useMemo(
    () => ({ preference, scheme, setPreference }),
    [preference, scheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Full theme controls (preference + resolved scheme + setter). */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}

/**
 * Resolved color scheme for the current theme. Falls back to "light" when used
 * outside a ThemeProvider so palette lookups never crash.
 */
export function useResolvedScheme(): ResolvedScheme {
  const ctx = useContext(ThemeContext);
  return ctx?.scheme ?? "light";
}
