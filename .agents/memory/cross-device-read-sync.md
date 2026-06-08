---
name: Cross-device read/unread sync
description: How own-device WhatsApp reads clear MaxiChat's unread badge, and the causal/scope guards that keep it safe.
---

# Cross-device read/unread sync (WhatsApp)

When a customer chat is read on ANY linked WhatsApp device, MaxiChat clears its own
unread badge within ~5s via the existing chat-list poll (no websocket/push). Propagation
is fully poll-backed (chat-list badge + sidebar total via the 5s `useListChats` refetch),
so this is a backend-only concern — no frontend change needed.

## The single causal guard
All read paths (chat-meta `unreadCount:0`, live read receipts, message-status updates)
converge on ONE guarded UPDATE: clear only when the read point covers the chat's latest
message (`lastMessageAt IS NULL OR lastMessageAt <= readUpTo`).
**Why:** a stale/out-of-order read event must never wipe a NEWER unread, and positive
unread counts are never mirrored (those are counted by MaxiChat's own inbound path).
**How to apply:** never write `unreadCount: 0` directly from a read event — always route
through the shared clear helper so the guard can't be bypassed.

## Two event sources, two timestamp regimes
- `message-receipt.update` carries an explicit read/played timestamp → use it as `readUpTo`.
  **Critical:** this event ALSO fires for non-read receipts (delivery/etc.). If it has NO
  read/played timestamp, return null and do NOT clear — a timestamp-less receipt is not
  evidence of a read. (A delivery receipt message-anchoring a clear was a real bug caught
  in review.)
- `messages.update` raising an inbound message to READ/PLAYED status carries NO timestamp →
  anchor on the referenced message's arrival time (`createdAt`). This is the safe home for
  timestamp-less reads because it is already filtered to READ/PLAYED status. The causal
  guard still prevents over-clearing.

## Scope guard (inbound clear only follows `key.fromMe` === false)
The unread-CLEAR path skips `key.fromMe`. We only clear MaxiChat's own unread for INBOUND
(customer) messages that *we* read on some device.

## Outbound counterpart: blue-tick mirroring (now in scope)
The SAME two events, with `key.fromMe === true`, drive a SEPARATE outbound feature: storing
the customer's delivery/read state per outbound message (`chat_messages.status` =
sent|delivered|read) so the chat UI shows single/double/blue ticks. db-free parsers
`outboundStatusFromMessageUpdate` (DELIVERY_ACK→delivered, READ/PLAYED→read) +
`outboundStatusFromReceiptUpdate` (read/playedTimestamp→read, receiptTimestamp→delivered)
sit alongside the inbound `ownRead*` parsers in `chat-read-sync.ts`. The route applies them
forward-only via a SQL rank guard (sent<delivered<read) so an out-of-order delivered can't
undo a read. Both directions are wired into the same `message-receipt.update` /
`messages.update` listeners — inbound and outbound parsers run on each item independently.
**Why:** a single event can be relevant to exactly one direction (fromMe gates it), so the
two parser families are mutually exclusive by `key.fromMe` and never conflict.

## Backfilling outbound ticks from history sync
Live tick events only advance status going forward, so messages sent before the feature
shipped (or while the socket was offline) stay a single grey check. Backfill rides the
existing `messaging-history.set` pass: the history row is a raw `WAMessageInfo` whose
last-known delivery/read state lives directly on `msg.status` (NOT under `update.status` like
the live `messages.update` event). The db-free `outboundStatusFromMessageInfo({key,status})`
parser reads it and the handler applies it through the SAME `applyOutboundStatusSignal`
forward-only rank guard.
**Why:** reusing the rank guard means a stale/lower history status can never downgrade a
live `read`, and the history sync is already a bounded recent window so the backfill stays
cheap with no extra query. No Baileys in-memory store exists, so reading an on-device receipt
store on reconnect was not an option — history sync is the only replay source.
