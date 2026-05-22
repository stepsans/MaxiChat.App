import { useMemo } from "react";
import {
  useListShortcuts,
  getListShortcutsQueryKey,
} from "@workspace/api-client-react";
import type { TextShortcut } from "@workspace/api-client-react";

// Hook that exposes the operator's text-expander map. Keys are lowercased so
// matching is case-insensitive (typed "/ALMT" still resolves to the "/almt"
// entry). The composer expander uses this map on every keystroke.
export function useShortcutMap(): Map<string, string> {
  const { data } = useListShortcuts({
    query: { queryKey: getListShortcutsQueryKey(), staleTime: 30_000 },
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (data ?? []) as TextShortcut[]) {
      m.set(s.shortcut.toLowerCase(), s.replacement);
    }
    return m;
  }, [data]);
}

// Expand any /shortcut tokens in `text`. While the user is mid-typing we only
// expand tokens followed by whitespace (so they still see what they typed up
// to the last character). When `finalize` is true (e.g. before sending) we
// also expand a trailing token that has no whitespace after it.
// Left-boundary guard: the `/` of a shortcut must start a fresh token. We
// reject anything that would put the slash inside a URL or path —
// alphanumerics, underscore, another slash, or a colon (covers `http://`,
// `file:/`, `a/b`). Start-of-string and ordinary whitespace/punctuation are
// allowed. Implemented via a negative lookbehind which all currently-shipped
// browser engines (Chrome 62+, Safari 16.4+, Firefox 78+) support.
const SHORTCUT_LEFT_BOUNDARY = "(?<![A-Za-z0-9_/:])";

export function expandShortcuts(
  text: string,
  map: Map<string, string>,
  finalize: boolean
): string {
  if (map.size === 0) return text;
  const midRe = new RegExp(
    `${SHORTCUT_LEFT_BOUNDARY}(\\/[A-Za-z0-9_]+)(\\s)`,
    "g"
  );
  let out = text.replace(midRe, (m, token: string, ws: string) => {
    const rep = map.get(token.toLowerCase());
    return rep !== undefined ? rep + ws : m;
  });
  if (finalize) {
    const tailRe = new RegExp(
      `${SHORTCUT_LEFT_BOUNDARY}(\\/[A-Za-z0-9_]+)$`,
      "g"
    );
    out = out.replace(tailRe, (m, token: string) => {
      const rep = map.get(token.toLowerCase());
      return rep !== undefined ? rep : m;
    });
  }
  return out;
}
