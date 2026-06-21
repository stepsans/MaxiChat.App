/**
 * Semantic design tokens for MaxiChat Mobile (v5 brand refresh).
 *
 * Brand orange: light `#F26A1B` (dark variant `#D2540C`, soft `#FDECE0`),
 * dark-mode `#FF7D33` (dark variant `#E0600F`, soft `#3A2412`). Green
 * (`#1F9D6B`) is reserved for positive meaning only — online, Leads, in-stock —
 * so it never collides with the brand accent. The WhatsApp connection dot keeps
 * its native `#25D366`.
 */

const colors = {
  light: {
    text: "#1c1410",
    tint: "#F26A1B",

    background: "#ffffff",
    foreground: "#1c1410",

    card: "#ffffff",
    cardForeground: "#1c1410",

    primary: "#F26A1B",
    primaryForeground: "#ffffff",
    primaryDark: "#D2540C",
    primarySoft: "#FDECE0",

    secondary: "#f5f0ec",
    secondaryForeground: "#1c1410",

    muted: "#f5f0ec",
    mutedForeground: "#7a6e64",

    accent: "#FF7D33",
    accentForeground: "#1c1410",

    destructive: "#E0503A",
    destructiveForeground: "#ffffff",

    border: "#ece5df",
    input: "#ece5df",

    bubbleIn: "#ffffff",
    bubbleOut: "#FDECE0",
    bubbleOutForeground: "#1c1410",
    chatBg: "#f4ece3",
    header: "#D2540C",
    headerForeground: "#ffffff",
    unreadBadge: "#F26A1B",
    tickRead: "#2F6DF0",

    // Semantic v5 tokens
    success: "#1F9D6B", // online · Leads · stok tersedia
    successSoft: "#E3F4EC",
    waDot: "#25D366", // WhatsApp channel connected indicator
    info: "#2F6DF0", // centang baca
    warning: "#E8941F", // hot lead / amber
    danger: "#E0503A", // perlu dibalas
  },

  dark: {
    text: "#f1e9e3",
    tint: "#FF7D33",

    background: "#16110d",
    foreground: "#f1e9e3",

    card: "#1f1813",
    cardForeground: "#f1e9e3",

    primary: "#FF7D33",
    primaryForeground: "#1a1209",
    primaryDark: "#E0600F",
    primarySoft: "#3A2412",

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
    unreadBadge: "#FF7D33",
    tickRead: "#5b8cff",

    // Semantic v5 tokens
    success: "#27B07C",
    successSoft: "#193227",
    waDot: "#25D366",
    info: "#5b8cff",
    warning: "#F0A93A",
    danger: "#ef6a57",
  },

  radius: 12,
};

export default colors;
