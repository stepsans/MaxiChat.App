// Pure, db-free helpers for syncing "read on the phone" state from Baileys
// chat events back into MaxiChat. Kept db-free so the parsing/causality logic
// is unit-testable (the actual DB write lives in the whatsapp route).

// Coerces a Baileys timestamp (number | numeric string | Long-like object with
// a toNumber()) into Unix seconds, or null when it isn't a usable positive
// value.
export function toUnixSeconds(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (v && typeof v === "object") {
    const fn = (v as { toNumber?: unknown }).toNumber;
    if (typeof fn === "function") {
      const n = (fn as () => unknown).call(v);
      if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// Given a Baileys chat object (from chats.update / chats.upsert), returns the
// timestamp up to which the chat has been read on the phone — i.e. when
// WhatsApp reports the chat as read (unreadCount === 0) AND carries a usable
// conversationTimestamp marking its latest known message.
//
// Returns null when the event is not a read-clear or carries no usable read
// point. The caller must use this as a *causal guard*: only clear MaxiChat's
// unread badge when this point is at or after the chat's last message, so a
// stale read event can never wipe a newer unread message. We never mirror
// positive unread counts (those are counted by MaxiChat's own inbound path).
export function readClearUpTo(c: Record<string, unknown>): Date | null {
  if (!Object.prototype.hasOwnProperty.call(c, "unreadCount")) return null;
  const u = (c as { unreadCount?: unknown }).unreadCount;
  if (typeof u !== "number" || u !== 0) return null;
  const secs = toUnixSeconds((c as { conversationTimestamp?: unknown }).conversationTimestamp);
  if (secs === null) return null;
  return new Date(secs * 1000);
}
