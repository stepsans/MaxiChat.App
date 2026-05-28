---
name: Telegram channel pipeline
description: How MaxiChat's Telegram channel mirrors the WhatsApp one — chat key encoding, webhook auth, secret redaction, and outbound dispatch differences from WA.
---

Telegram is wired as a second channel kind alongside WhatsApp (Baileys). Key invariants:

- **Chat identity reuses `chats.phone_number`**, prefixed `tg:<chat_id>`. The negative ids Telegram uses for groups stay distinct from positive private ids, and the prefix prevents collisions with WA's `+digits`. Dedupe of inbound/outbound messages reuses `chat_messages.wa_message_id` as `tg:<chat_id>:<message_id>` — the chat_id MUST be in the key because Telegram message_id is only unique per chat, while `chat_messages.wa_message_id` is globally unique (single-column index in `lib/db/src/schema/whatsapp.ts`). Drop the chat_id and two different Telegram chats sharing `message_id=1` will collide and the second insert is silently swallowed by `onConflictDoNothing`.

  **Why:** avoids a schema migration for v1 while keeping the unique (channel_id, phone_number) index honest.
  **How to apply:** when adding a third channel kind, pick a new prefix (e.g. `ig:`) and keep the same column.

- **Webhook auth is the `X-Telegram-Bot-Api-Secret-Token` header, not a session.** The webhook router must be mounted BEFORE `requireAuth` in `routes/index.ts`. The expected secret is generated at /connect-telegram time and stored in `channels.metadata.telegram.webhookSecret`. Compare with `timingSafeEqual` (length-check first).

  **Why:** Telegram has no cookie. Without the secret, anyone could spoof inbound updates.
  **How to apply:** never log the secret; never expose it in serialize() — `redactMetadata` strips `botToken` + `webhookSecret`.

- **Outbound dispatch is NOT symmetric with WhatsApp.** Baileys echoes outbound sends back through `messages.upsert`, so for WA we only insert into the DB. Telegram has no echo, so `chats /reply` and the AI auto-reply path must actively call `sendMessage` AND insert the outbound row themselves.

  **Why:** missing this is the most likely "the bot is silent" regression.
  **How to apply:** any new "send to recipient" code path must branch on `channel.kind` and call the per-channel transport before persisting.

- **MVP scope:** text only, private chats only, no chatbot-flow engine (flows are WA-runtime coupled today). AI auto-reply via `generateAiReply` is reused as-is — it is channel-agnostic.

- **Webhook URL** derived from `REPLIT_DOMAINS[0]` → `https://<domain>/api/webhooks/telegram/<channelId>`. Requires HTTPS; localhost won't work. Telegram registration happens synchronously at /connect-telegram, so token-invalid / DNS / network errors surface to the user immediately.
