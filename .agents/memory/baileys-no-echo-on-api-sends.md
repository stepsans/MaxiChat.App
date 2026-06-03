---
name: Baileys does not deliver via echo
description: Every outbound message path must explicitly call sock.sendMessage; recording a DB row alone never transmits.
---

# Baileys does not "echo-send" your API-initiated messages

Recording an outbound `chat_messages` row does NOT send anything over WhatsApp.
Each send endpoint must explicitly call `sock.sendMessage(jid, ...)`. Baileys'
`messages.upsert` echo only fires *after* a real send (it mirrors the message
back so we can dedupe), so you cannot rely on "the echo will deliver it."

**Why:** The manual text-reply path (`POST /chats/:id/reply`) for WhatsApp once
only inserted the row and showed two ticks in the UI while never transmitting —
messages silently never reached the recipient (null `wa_message_id` was the
tell; genuinely-sent messages always carry a real WA id). Media/contact/
product/quotation paths worked because they *do* call a send helper.

**How to apply:**
- Any new outbound path: send first, then persist the row tagged with the
  returned `sent.key.id` as `waMessageId`, and `onConflictDoNothing` on
  `wa_message_id` so the inbound echo dedupes instead of duplicating.
- Return an error (502/503) on send failure or missing socket — never record a
  row as if it succeeded.
- Send over the **chat's own channel** socket (`getSockForChannel(chat.channelId)`),
  not the user's primary channel: group chats belong to the specific paired
  number that is a member of that group, so sending via the primary account can
  silently fail (not in group). NOTE: media/contact/product/quotation helpers
  (`sendMediaToJid`/`sendContactToJid`) still use the primary channel — a known
  remaining inconsistency that can misfire for non-primary-channel chats.
