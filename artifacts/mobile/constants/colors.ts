/**
 * Semantic design tokens for MaxiChat Mobile.
 *
 * WhatsApp-inspired palette so the mobile app matches the product's identity:
 * teal-green primary, soft chat surfaces, dark mode tuned to WhatsApp dark.
 */

const colors = {
  light: {
    text: "#0b141a",
    tint: "#128c7e",

    background: "#ffffff",
    foreground: "#0b141a",

    card: "#ffffff",
    cardForeground: "#0b141a",

    primary: "#128c7e",
    primaryForeground: "#ffffff",

    secondary: "#f0f2f5",
    secondaryForeground: "#0b141a",

    muted: "#f0f2f5",
    mutedForeground: "#667781",

    accent: "#25d366",
    accentForeground: "#06140d",

    destructive: "#ef4444",
    destructiveForeground: "#ffffff",

    border: "#e9edef",
    input: "#e9edef",

    bubbleIn: "#ffffff",
    bubbleOut: "#d9fdd3",
    bubbleOutForeground: "#0b141a",
    chatBg: "#efeae2",
    header: "#075e54",
    headerForeground: "#ffffff",
    unreadBadge: "#25d366",
  },

  dark: {
    text: "#e9edef",
    tint: "#25d366",

    background: "#0b141a",
    foreground: "#e9edef",

    card: "#111b21",
    cardForeground: "#e9edef",

    primary: "#00a884",
    primaryForeground: "#06140d",

    secondary: "#202c33",
    secondaryForeground: "#e9edef",

    muted: "#202c33",
    mutedForeground: "#8696a0",

    accent: "#25d366",
    accentForeground: "#06140d",

    destructive: "#f15c6d",
    destructiveForeground: "#ffffff",

    border: "#222d34",
    input: "#2a3942",

    bubbleIn: "#202c33",
    bubbleOut: "#005c4b",
    bubbleOutForeground: "#e9edef",
    chatBg: "#0b141a",
    header: "#1f2c33",
    headerForeground: "#e9edef",
    unreadBadge: "#00a884",
  },

  radius: 12,
};

export default colors;
