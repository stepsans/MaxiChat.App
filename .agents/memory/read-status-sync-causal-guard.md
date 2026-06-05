---
name: Read-status sync (phone → MaxiChat) causal guard
description: How "read on the phone" clears MaxiChat's unread badge without a stale event wiping a newer unread.
---

Syncing WhatsApp "read on the phone" back into MaxiChat (clear the unread badge) must be **read-direction only and causally guarded**.

Rules:
- Only mirror the *clear* direction (WA `unreadCount === 0`). Never mirror positive
  unread counts — inbound increments are owned by MaxiChat's own message-ingest path,
  so mirroring them double-counts.
- The clear must be **atomic + causal**, not a read-modify-write. A stale `chats.update`
  (e.g. during history/app-state resync) carrying `unreadCount: 0` can arrive *after* a
  genuine new inbound message already bumped the badge. An unconditional `SET unread=0`
  then silently loses unread state.
- Guard against the chat's monotonic last-message time: only clear when the phone's read
  point (Baileys `conversationTimestamp`) is at or after the chat's `lastMessageAt`
  (which only advances forward). Express it in the SQL `WHERE`
  (`last_message_at IS NULL OR last_message_at <= readUpTo`) so a concurrent increment is
  respected atomically.
- When the read event has **no usable `conversationTimestamp`**, skip clearing entirely.
  Causality can't be established, so clearing risks the regression; a missed clear is
  cheaper than a lost unread.

**Why:** the stale-read-vs-new-message interleave is a real race the unconditional
version introduced.

**How to apply:** keep the pure parse in the db-free helper (`conversationTimestamp` /
Long-like coercion) so it's unit-testable; keep the causal comparison in the SQL UPDATE.
`conversationTimestamp` may be a number, numeric string, or a Long-like object with
`.toNumber()`.

The chat-list "unread only" filter is purely client-side in ChatListPane (like the label
filter): `matchUnread = !unreadOnly || (c.unreadCount ?? 0) > 0`; no backend/contract change.
