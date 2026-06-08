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

// ---------------------------------------------------------------------------
// OUTBOUND direction: mirror WhatsApp's blue ticks on messages WE sent.
//
// This is the reverse of the inbound read-sync above. A receipt/status event on
// one of OUR OWN (`key.fromMe`) outbound messages tells us the CUSTOMER's
// delivery/read state for that message — the single/double/blue tick the
// operator sees. We store this per outbound message so the chat UI can show it.
// ---------------------------------------------------------------------------

// The delivery/read state of an outbound message, in strictly increasing order
// of progress. We never downgrade (a "read" message can't go back to
// "delivered"); the caller enforces forward-only advancement.
export type OutboundStatus = "delivered" | "read";

// Numeric rank used to compare progress. Higher = further along. "sent" is the
// implicit baseline (rank 0) every outbound message starts at, so it isn't a
// signal we ever emit — only delivered/read advance the stored state.
export const OUTBOUND_STATUS_RANK: Record<string, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
};

// A normalized "the customer's delivery/read state for an outbound message I
// sent" signal, derived from a fromMe receipt/status event.
export interface OutboundStatusSignal {
  // The chat JID the message belongs to (group @g.us or 1:1 @s.whatsapp.net).
  remoteJid: string;
  // The WA id of the outbound message whose status changed. Required — we key
  // the per-message update on this, so a signal without one is useless.
  messageId: string;
  // The new delivery/read state.
  status: OutboundStatus;
}

// Extract the remoteJid + REQUIRED messageId from a Baileys message key for our
// OWN outbound messages (the mirror image of inboundKeyParts). Returns null for
// inbound messages and for keys missing a usable remoteJid or id.
function outboundKeyParts(
  key: WaKeyLike,
): { remoteJid: string; messageId: string } | null {
  if (!key) return null;
  if (!key.fromMe) return null;
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== "string" || remoteJid === "") return null;
  if (typeof key.id !== "string" || key.id === "") return null;
  return { remoteJid, messageId: key.id };
}

// WA proto message statuses (proto.WebMessageInfo.Status):
// PENDING=0/1, SERVER_ACK=2 (sent), DELIVERY_ACK=3 (delivered), READ=4, PLAYED=5.
const WA_STATUS_DELIVERY_ACK = 3;

// Map a Baileys message status (number or enum string) to our outbound state,
// or null when it carries no delivered/read progress (sent/pending/error).
function outboundStatusFromCode(status: unknown): OutboundStatus | null {
  if (isReadStatus(status)) return "read";
  if (typeof status === "number") {
    return status === WA_STATUS_DELIVERY_ACK ? "delivered" : null;
  }
  if (typeof status === "string") {
    return status.toUpperCase() === "DELIVERY_ACK" ? "delivered" : null;
  }
  return null;
}

// Derive an outbound-status signal from a Baileys `messages.update` item when
// the update raises one of OUR OWN messages to DELIVERY_ACK/READ/PLAYED. Returns
// null for inbound messages, our own SERVER_ACK/pending updates, and non-status
// updates (edits, revokes, etc.).
export function outboundStatusFromMessageUpdate(item: {
  key?: WaKeyLike;
  update?: { status?: unknown } | null | undefined;
}): OutboundStatusSignal | null {
  const parts = outboundKeyParts(item?.key);
  if (!parts) return null;
  const status = outboundStatusFromCode(item?.update?.status);
  if (!status) return null;
  return { remoteJid: parts.remoteJid, messageId: parts.messageId, status };
}

// Derive an outbound-status signal from a Baileys `message-receipt.update` item
// for our OWN messages. A read/played timestamp means the customer READ it; a
// receipt timestamp alone means it was DELIVERED. Returns null when the receipt
// carries no usable delivery/read timestamp.
export function outboundStatusFromReceiptUpdate(item: {
  key?: WaKeyLike;
  receipt?:
    | {
        readTimestamp?: unknown;
        playedTimestamp?: unknown;
        receiptTimestamp?: unknown;
      }
    | null
    | undefined;
}): OutboundStatusSignal | null {
  const parts = outboundKeyParts(item?.key);
  if (!parts) return null;
  const r = item?.receipt;
  const readSecs =
    toUnixSeconds(r?.readTimestamp) ?? toUnixSeconds(r?.playedTimestamp);
  if (readSecs !== null) {
    return { remoteJid: parts.remoteJid, messageId: parts.messageId, status: "read" };
  }
  if (toUnixSeconds(r?.receiptTimestamp) !== null) {
    return {
      remoteJid: parts.remoteJid,
      messageId: parts.messageId,
      status: "delivered",
    };
  }
  return null;
}
