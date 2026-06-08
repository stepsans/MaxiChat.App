/**
 * Semantic design tokens for MaxiChat Mobile.
 *
 * Orange brand palette: warm orange primary with WhatsApp-style chat surfaces.
 * Dark mode is tuned to a deep neutral with an orange accent so contrast stays
 * readable on dark backgrounds.
 */

const colors = {
  light: {
    text: "#1c1410",
    tint: "#f97316",

    background: "#ffffff",
    foreground: "#1c1410",

    card: "#ffffff",
    cardForeground: "#1c1410",

    primary: "#f97316",
    primaryForeground: "#ffffff",

    secondary: "#f5f0ec",
    secondaryForeground: "#1c1410",

    muted: "#f5f0ec",
    mutedForeground: "#7a6e64",

    accent: "#fb923c",
    accentForeground: "#1c1410",

    destructive: "#ef4444",
    destructiveForeground: "#ffffff",

    border: "#ece5df",
    input: "#ece5df",

    bubbleIn: "#ffffff",
    bubbleOut: "#ffe8d2",
    bubbleOutForeground: "#1c1410",
    chatBg: "#f4ece3",
    header: "#ea580c",
    headerForeground: "#ffffff",
    unreadBadge: "#f97316",
  },

  dark: {
    text: "#f1e9e3",
    tint: "#fb923c",

    background: "#16110d",
    foreground: "#f1e9e3",

    card: "#1f1813",
    cardForeground: "#f1e9e3",

    primary: "#fb923c",
    primaryForeground: "#1a1209",

    secondary: "#2a221b",
    secondaryForeground: "#f1e9e3",

    muted: "#2a221b",
    mutedForeground: "#a8998c",

    accent: "#fdba74",
    accentForeground: "#1a1209",

    destructive: "#f15c6d",
    destructiveForeground: "#ffffff",

    border: "#332a22",
    input: "#332a22",

    bubbleIn: "#241c16",
    bubbleOut: "#6b3f1d",
    bubbleOutForeground: "#f7ede4",
    chatBg: "#16110d",
    header: "#2a1d12",
    headerForeground: "#f1e9e3",
    unreadBadge: "#fb923c",
  },

  radius: 12,
};

export default colors;
