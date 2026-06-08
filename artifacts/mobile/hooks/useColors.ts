import colors from "@/constants/colors";
import { useResolvedScheme } from "@/contexts/ThemeContext";

/**
 * Returns the design tokens for the active color scheme.
 *
 * The scheme is driven by the in-app theme preference (light / dark / system)
 * from ThemeContext — `system` follows the device appearance. The returned
 * object contains all color tokens for the active palette plus scheme-
 * independent values like `radius`.
 */
export function useColors() {
  const scheme = useResolvedScheme();
  const palette = scheme === "dark" ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}
