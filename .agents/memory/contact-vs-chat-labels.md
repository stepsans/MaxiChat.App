---
name: Customer labels are contact-level, not chat-level
description: Why labels key off (ownerUserId, phoneNumber) and how reads/writes/analytics must resolve them
---

Customer labels follow the CONTACT (a phone number under an owner), not an
individual chat row. Storage table is `contact_labels(ownerUserId, phoneNumber,
labelId)` unique on all three. There is NO per-chat `chat_labels` table anymore.

**Why:** the same WhatsApp number can have a separate chat row per channel
(chats are unique on channel_id+phone_number). A label set on one channel must
appear on the same number in every other channel of that owner, and on chats
created later for that number. Per-chat storage couldn't express that.

**How to apply:**
- To attach a chat's labels for serialization, resolve by joining
  chats → channels (for owner = channels.userId) → contact_labels (matching
  ownerUserId + phoneNumber) → customer_labels, then key the result map by
  chat.id. Never query a label table by chatId — that column no longer exists.
- Writes (PUT /chats/:id/labels) replace the whole set for
  (requireOwnerUserId, chat.phoneNumber), not for the chatId.
- "Chat per label" analytics counts CHATS (a contact in 2 channels = 2), by the
  same chats→channels→contact_labels→customer_labels join. Intentional, matches
  the "Chat per Label" wording.
- Telegram chats store phoneNumber as `tg:<id>`, so they never cross-link with
  WhatsApp numbers — correct and intended.
