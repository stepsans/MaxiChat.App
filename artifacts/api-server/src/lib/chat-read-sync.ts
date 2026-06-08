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

// A normalized "I read this chat on a WhatsApp device" signal, derived from a
// read-receipt / message-status event. The chat-meta path above only fires
// when WhatsApp re-sends the chat object with unreadCount:0 + a
// conversationTimestamp, which it frequently does NOT do for own-cross-device
// reads. These receipt/update events are the broader signal.
export interface OwnReadSignal {
  // The chat JID the read applies to (group @g.us or 1:1 @s.whatsapp.net).
  remoteJid: string;
  // The read point in time, or null when the event carries no usable
  // timestamp — the caller must then anchor on the referenced message's
  // arrival time (see `messageId`) so a read with no clock can still clear,
  // while the caller's causal guard prevents wiping a newer unread.
  readUpTo: Date | null;
  // The WA id of the message the receipt/update references, used for the
  // message-anchored fallback when `readUpTo` is null.
  messageId: string | null;
}

type WaKeyLike =
  | {
      fromMe?: boolean | null;
      remoteJid?: string | null;
      id?: string | null;
    }
  | null
  | undefined;

// Extract the remoteJid + optional messageId from a Baileys message key,
// rejecting receipts on our OWN outbound messages. A receipt on a fromMe
// message means the *customer* read what we sent (the blue double-check) —
// that's explicitly out of scope; we only ever clear MaxiChat's own unread
// badge for INBOUND (customer) messages that *we* read.
function inboundKeyParts(
  key: WaKeyLike,
): { remoteJid: string; messageId: string | null } | null {
  if (!key) return null;
  if (key.fromMe) return null;
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== "string" || remoteJid === "") return null;
  return {
    remoteJid,
    messageId: typeof key.id === "string" && key.id !== "" ? key.id : null,
  };
}

// Derive an own-read signal from a Baileys `message-receipt.update` item
// (`{ key, receipt }`). A read-self receipt carries `receipt.readTimestamp`
// (or `playedTimestamp` for voice notes). Returns null unless the receipt
// carries a positive read/played timestamp — `message-receipt.update` also
// fires for non-read receipts (delivery/etc.), and without a read timestamp we
// have NO evidence the chat was actually read, so we must NOT clear unread.
// (Timestamp-less reads are still covered by the READ/PLAYED-filtered
// `messages.update` path, which message-anchors safely.)
export function ownReadFromReceiptUpdate(item: {
  key?: WaKeyLike;
  receipt?:
    | { readTimestamp?: unknown; playedTimestamp?: unknown }
    | null
    | undefined;
}): OwnReadSignal | null {
  const parts = inboundKeyParts(item?.key);
  if (!parts) return null;
  const r = item?.receipt;
  const secs =
    toUnixSeconds(r?.readTimestamp) ?? toUnixSeconds(r?.playedTimestamp);
  if (secs === null) return null;
  return {
    remoteJid: parts.remoteJid,
    readUpTo: new Date(secs * 1000),
    messageId: parts.messageId,
  };
}

// WA proto message statuses (proto.WebMessageInfo.Status): READ = 4, PLAYED = 5.
const WA_STATUS_READ = 4;
const WA_STATUS_PLAYED = 5;

function isReadStatus(status: unknown): boolean {
  if (typeof status === "number") {
    return status === WA_STATUS_READ || status === WA_STATUS_PLAYED;
  }
  if (typeof status === "string") {
    const s = status.toUpperCase();
    return s === "READ" || s === "PLAYED";
  }
  return false;
}

// Derive an own-read signal from a Baileys `messages.update` item
// (`{ key, update }`) when the update raises an INBOUND message to READ/PLAYED
// status (i.e. we read the customer's message, possibly on another device).
// `messages.update` carries no timestamp, so `readUpTo` is always null here and
// the caller anchors on the referenced message. Returns null for our own
// outbound status changes (delivered/read-by-customer) and non-read updates.
export function ownReadFromMessageUpdate(item: {
  key?: WaKeyLike;
  update?: { status?: unknown } | null | undefined;
}): OwnReadSignal | null {
  const parts = inboundKeyParts(item?.key);
  if (!parts) return null;
  if (!isReadStatus(item?.update?.status)) return null;
  return {
    remoteJid: parts.remoteJid,
    readUpTo: null,
    messageId: parts.messageId,
  };
}
