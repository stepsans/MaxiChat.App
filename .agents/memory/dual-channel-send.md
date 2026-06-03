---
name: Dual-channel outbound send (WhatsApp + Telegram)
description: How to send a message/document to a chat over its channel — always bind WA sends to the chat's OWN channel socket.
---

# Sending outbound to a chat over its channel

Established pattern (see `chats.ts` `/reply`, `/media`, `/quotation`, react, pin, forward):
branch on the chat's channel `kind`.

- **Telegram**: read `channel.metadata.telegram.botToken`, derive numeric chat id from
  `chat.phoneNumber` (`tg:<id>` → strip prefix), call the telegram lib. Telegram has NO
  inbound echo, so you MUST actively push AND record the outbound row yourself; build a
  dedupe key `tg:<chatId>:<messageId>`.
- **WhatsApp**: resolve the socket with **`getSockForChannel(chat.channelId)`** (synchronous,
  returns `WASocket | null`) and send via `sock.sendMessage` / `sendMediaToJid`. Resolve the
  jid via `jidForChat` (groups already hold `<id>@g.us`; personal = `<digits>@s.whatsapp.net`).

## Rule: WA sends bind to the chat's OWN channel, NOT the primary
**Why:** a group belongs to the specific paired number that is a member of it, and a tenant can
have multiple WA channels (e.g. WA VS + SS XL under one owner). Sending via the wrong account
silently fails ("not in group") or goes out from the wrong business identity, and the Baileys
echo is then persisted under the sending socket's channel → cross-channel message drift.

**How to apply:** every actual WA *send* of a message to a chat MUST use
`getSockForChannel(chat.channelId)`. `getActiveSocket(userId)` returns the PRIMARY socket only —
use it ONLY as a "is any WA connected?" guard or for channel-less creation flows, never as the
send socket for an existing chat. (Historical note: forward once used `getActiveSocket` for its
real send — that was a bug, fixed to `getSockForChannel(targetChat.channelId)`. If you find any
remaining existing-chat send on `getActiveSocket`, it is almost certainly the same bug.)

## Telegram document send
Telegram `sendDocument` needs `multipart/form-data` — the JSON `call()` helper in
`telegram.ts` can't carry binary. Use `FormData` + a `Blob` and POST directly. Copy the
buffer into a fresh `Uint8Array` before `new Blob([bytes])` or TS rejects it
(`SharedArrayBuffer` not assignable to `BlobPart`).

## Recording the message
Mirror `/media`: persist the file under `MEDIA_DIR`, insert a `chat_messages` row with
`mediaType:"document"`, `mediaUrl:/api/media/<file>`, and `waMessageId` = the send's dedupe
key, using `onConflictDoNothing` on `wa_message_id` so the Baileys echo doesn't duplicate.
The media file is meant to persist (it's served back via `/api/media/`) — only unlink it on
*pre-send / send-failure* paths, never after a successful send.
