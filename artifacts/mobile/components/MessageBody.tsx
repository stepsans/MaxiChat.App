import React, { useEffect, useState } from "react";
import {
  Image,
  Linking,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
} from "react-native";

import { getLinkPreview, type LinkPreview } from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";

// Matches http(s) URLs and bare "www." / domain-style links so we can render
// them as tappable text. Mirrors the web regex (ConversationPane.tsx) so both
// clients linkify identically.
export const URL_RE =
  /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}'"]|[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|co|id|ai|app|dev|me|info|biz|store|xyz|link|gg|tv)(?:\/[^\s<]*)?)/gi;

// Normalize a matched link into a URL the OS can open. Bare domains / "www."
// links get an https:// scheme so Linking opens them as absolute URLs.
export function hrefForLink(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// Return the first link found in a body, or null. Used to decide whether to
// render a link-preview card for the message.
export function firstLink(text: string): string | null {
  if (!text) return null;
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}

function openLink(raw: string): void {
  // Opens the device browser, or a registered app (deep link) when the OS has
  // one bound to the URL. Failures (no handler) are swallowed.
  void Linking.openURL(hrefForLink(raw)).catch(() => {});
}

// Render a message body as text with every detected URL turned into a tappable
// link. Nested <Text onPress> keeps the links inline within the paragraph.
export function LinkifiedText({
  content,
  color,
  linkColor,
  style,
}: {
  content: string;
  color: string;
  linkColor: string;
  style?: TextStyle | TextStyle[];
}) {
  const nodes: React.ReactNode[] = [];
  URL_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = URL_RE.exec(content)) !== null) {
    if (m.index > last) nodes.push(content.slice(last, m.index));
    const raw = m[0];
    nodes.push(
      <Text
        key={`lnk-${i++}-${m.index}`}
        style={{ color: linkColor, textDecorationLine: "underline" }}
        onPress={() => openLink(raw)}
        suppressHighlighting
      >
        {raw}
      </Text>,
    );
    last = m.index + raw.length;
  }
  if (last < content.length) nodes.push(content.slice(last));
  return <Text style={[style as TextStyle, { color }]}>{nodes}</Text>;
}

// A WhatsApp-style link-preview card. Fetches OpenGraph metadata for the URL
// from the server (SSRF-guarded) and renders a tappable thumbnail + title +
// description. Renders nothing until/unless useful metadata is available.
export function LinkPreviewCard({
  url,
  isOutbound,
}: {
  url: string;
  isOutbound: boolean;
}) {
  const colors = useColors();
  const [data, setData] = useState<LinkPreview | null>(null);
  const [imgError, setImgError] = useState(false);
  // Normalize before fetching: linkified text can include scheme-less links
  // (e.g. "www.example.com"); the server parses with new URL() and rejects
  // those, so send the canonical href the card itself opens.
  const fetchUrl = hrefForLink(url);

  useEffect(() => {
    let alive = true;
    setData(null);
    setImgError(false);
    getLinkPreview({ url: fetchUrl })
      .then((res) => {
        if (alive) setData(res);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [fetchUrl]);

  if (!data || (!data.title && !data.description && !data.image)) return null;

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => openLink(url)}
      style={[
        styles.card,
        {
          backgroundColor: isOutbound ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
          borderColor: colors.border,
        },
      ]}
    >
      {data.image && !imgError ? (
        <Image
          source={{ uri: data.image }}
          style={styles.cardImage}
          resizeMode="cover"
          onError={() => setImgError(true)}
        />
      ) : null}
      <View style={styles.cardBody}>
        {data.siteName ? (
          <Text
            style={[styles.cardSite, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {data.siteName.toUpperCase()}
          </Text>
        ) : null}
        {data.title ? (
          <Text
            style={[styles.cardTitle, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {data.title}
          </Text>
        ) : null}
        {data.description ? (
          <Text
            style={[styles.cardDesc, { color: colors.mutedForeground }]}
            numberOfLines={2}
          >
            {data.description}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    marginBottom: 4,
  },
  cardImage: {
    width: "100%",
    height: 140,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  cardBody: { paddingHorizontal: 9, paddingVertical: 7, gap: 1 },
  cardSite: {
    fontFamily: "Inter_500Medium",
    fontSize: 9.5,
    letterSpacing: 0.4,
  },
  cardTitle: { fontFamily: "Inter_600SemiBold", fontSize: 12.5 },
  cardDesc: { fontFamily: "Inter_400Regular", fontSize: 11.5 },
});
