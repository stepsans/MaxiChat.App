---
name: Dual-channel outbound send (WhatsApp + Telegram)
description: How to send a message/document to a chat over its channel, and the primary-WA-socket constraint that affects all WA sends.
---

# Sending outbound to a chat over its channel

Established pattern (see `chats.ts` `/reply`, `/media`, `/quotation`): branch on the
chat's channel `kind`.

- **Telegram**: read `channel.metadata.telegram.botToken`, derive numeric chat id from
  `chat.phoneNumber` (`tg:<id>` → strip prefix), call the telegram lib. Telegram has NO
  inbound echo, so you MUST actively push AND record the outbound row yourself; build a
  dedupe key `tg:<chatId>:<messageId>`.
- **WhatsApp**: use `sendMediaToJid` / socket send. Resolve the jid via `jidForChat`
  (groups already hold `<id>@g.us`; personal = `<digits>@s.whatsapp.net`).

## Constraint: WA sends always use the PRIMARY channel
**Every** WhatsApp send helper (`sendMediaToJid`, `getActiveSocket`, contact/flow sends)
resolves the socket via `getPrimaryCtxForUser(ownerUserId)` — the tenant's *first/primary*
WA channel — NOT the specific `chat.channelId`.

**Why it matters:** "deliver over the chat's channel" is only truly honored for Telegram.
For a tenant with multiple WA channels, WA sends go out from the primary account. This is
app-wide, not a per-endpoint bug; don't "fix" it in one route — it would diverge from every
sibling and needs a channel-specific send helper that doesn't exist yet.

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
