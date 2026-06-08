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

## Scope guard (out of scope = blue ticks)
Skip `key.fromMe`. A receipt on a fromMe (outbound) message means the *customer* read what
we sent (blue double-check) — explicitly out of scope. We only clear MaxiChat's own unread
for INBOUND (customer) messages that *we* read on some device.
