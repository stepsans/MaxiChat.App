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
const WALLPAPER_KEY = "maxichat.chat.wallpaper";

/** "default" follows the theme's chat background; otherwise a hex color. */
export type Wallpaper = string;

/** Preset chat wallpapers offered in Setting › Tampilan. */
export const WALLPAPER_OPTIONS: { value: Wallpaper; label: string; color: string | null }[] = [
  { value: "default", label: "Bawaan", color: null },
  { value: "#EDE7DD", label: "Krem", color: "#EDE7DD" },
  { value: "#D9E7DD", label: "Mint", color: "#D9E7DD" },
  { value: "#DCE6F2", label: "Biru", color: "#DCE6F2" },
  { value: "#ECE0F2", label: "Ungu", color: "#ECE0F2" },
  { value: "#1B2733", label: "Malam", color: "#1B2733" },
];

interface ThemeContextValue {
  /** The user's chosen preference (light/dark/system). */
  preference: ThemePreference;
  /** The actual scheme to render (system resolves to the device setting). */
  scheme: ResolvedScheme;
  setPreference: (pref: ThemePreference) => void;
  /** Chat wallpaper ("default" or a hex color). */
  wallpaper: Wallpaper;
  setWallpaper: (w: Wallpaper) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const device = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [wallpaper, setWallpaperState] = useState<Wallpaper>("default");

  // Load the persisted preferences once on mount.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (alive && (v === "light" || v === "dark" || v === "system")) {
          setPreferenceState(v);
        }
      })
      .catch(() => {});
    AsyncStorage.getItem(WALLPAPER_KEY)
      .then((v) => {
        if (alive && v) setWallpaperState(v);
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

  const setWallpaper = (w: Wallpaper) => {
    setWallpaperState(w);
    AsyncStorage.setItem(WALLPAPER_KEY, w).catch(() => {});
  };

  const scheme: ResolvedScheme =
    preference === "system" ? (device === "dark" ? "dark" : "light") : preference;

  const value = useMemo(
    () => ({ preference, scheme, setPreference, wallpaper, setWallpaper }),
    [preference, scheme, wallpaper],
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
