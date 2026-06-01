---
name: Message delete / revoke constraints
description: Rules for "delete for me" vs "delete for everyone" on chat messages across WhatsApp + Telegram.
---

# Message delete (per-message)

Two distinct operations, do not conflate them:

- **Delete for me** = local-only: remove the `chat_messages` row. Works for ANY
  message (inbound or outbound), any channel. No channel call.
- **Delete for everyone (revoke)** = recall on the channel, THEN drop the local
  row.

**Why outbound-only:** WhatsApp and Telegram only let you recall your OWN
(outbound) messages, and only within a time window. So revoke MUST reject
inbound messages (400) and messages with no `waMessageId` (nothing to target).

**How to apply (dual-channel revoke key derivation):**
- WhatsApp: use `getSockForChannel(chat.channelId)` (the chat's own account, not
  the primary), `sock.sendMessage(jid, { delete: { remoteJid, fromMe:true, id:
  waMessageId, participant? } })`. Groups need `participant` = our own jid
  (`sock.user.id`); omit for 1:1.
- Telegram: outbound rows store `waMessageId` as `tg:<chatId>:<messageId>` — split
  on ":" to get chat_id + message_id, then `deleteMessage`. Handles negative
  (supergroup) chat ids via parseInt.
- A failed channel recall (too old, etc.) must NOT delete the local row — surface
  a 400 so the operator knows it wasn't actually recalled.
