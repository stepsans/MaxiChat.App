import { useMemo } from "react";

import colors from "@/constants/colors";
import { useResolvedScheme } from "@/contexts/ThemeContext";

/**
 * Returns the design tokens for the active color scheme.
 *
 * The scheme is driven by the in-app theme preference (light / dark / system)
 * from ThemeContext — `system` follows the device appearance. The returned
 * object contains all color tokens for the active palette plus scheme-
 * independent values like `radius`.
 *
 * The result is memoized per scheme so it keeps a stable referential identity
 * across renders. This is load-bearing for performance: `React.memo`'d list
 * rows/cards receive `colors` as a prop, and a fresh object every render would
 * defeat their memoization and force the whole list to re-render on every poll.
 */
export function useColors() {
  const scheme = useResolvedScheme();
  return useMemo(() => {
    const palette = scheme === "dark" ? colors.dark : colors.light;
    return { ...palette, radius: colors.radius };
  }, [scheme]);
}
