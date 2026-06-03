---
name: chat_messages dedup is per-chat, not global
description: Why wa_message_id must be unique on (chat_id, wa_message_id) and never on wa_message_id alone.
---

# chat_messages dedup must be scoped per chat

`chat_messages.wa_message_id` is unique on the COMPOSITE `(chat_id, wa_message_id)`,
never on `wa_message_id` alone.

**Why:** WhatsApp delivers one message with the SAME message id to every group
participant. With separate channels paired for two accounts that share a group
(e.g. SS Halo + SS XL in the same group), the same id legitimately needs one row
per channel's chat: the sender's outbound row AND each other channel's inbound
copy. A global unique index on `wa_message_id` let the first writer win and every
`onConflictDoNothing({ target: waMessageId })` on the other channels silently
dropped their copy — so the second channel's group view stayed empty even though
its socket was healthy and receiving everything else. Symptom looked like "channel
B never receives channel A's group messages, but the phone does."

**How to apply:**
- Every `onConflictDoNothing` on `chatMessagesTable` must target
  `[chatMessagesTable.chatId, chatMessagesTable.waMessageId]` (WA persist, all
  outbound send paths in chats.ts, sales-orders.ts, and the Telegram webhook).
  ON CONFLICT REQUIRES a matching unique index, so leaving any site on the bare
  column will throw at runtime once the global index is dropped.
- Any fallback `select ... where(eq(waMessageId, x))` (used to fetch the existing
  row after a conflict) MUST also filter by `chatId`, or it can return a different
  channel's copy of the same id.
- Telegram keys (`tg:<chatId>:<msgId>`) are already chat-scoped, so the composite
  is a no-op for them — but their onConflict target still has to be the composite.
- Applying the index swap: drizzle-kit push prompts interactively on unique-index
  changes (see drizzle-push-tty.md). Do it via psql: CREATE the composite UNIQUE
  index, then DROP the old `chat_messages_wa_message_id_unique`.
