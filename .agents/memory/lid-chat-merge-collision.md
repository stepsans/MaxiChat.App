---
name: LID-chat merge wa_message_id collision drops messages
description: Why 1:1 messages silently vanished on the dashboard — the stale-LID-chat → canonical-chat merge in persistWaMessage aborts on a duplicate wa_message_id and then drops every later message. Read when 1:1 (not group) messages are missing despite a healthy connection.
---

# LID→canonical chat merge must not collide on the unique key

When a 1:1 WhatsApp message arrives carrying BOTH a privacy LID and a real phone
JID (`lidRawNumber !== rawNumber`), `persistWaMessage` reconciles the stale
LID-keyed chat into the canonical phone chat by reassigning its messages
(`UPDATE chat_messages SET chat_id = canonical WHERE chat_id = lidChat`).

## The trap
The same WhatsApp message can already exist in BOTH chats (once keyed by LID,
once by phone). A blind reassignment then violates the
`chat_messages_chat_wa_message_id_unique (chat_id, wa_message_id)` constraint.
The whole transaction aborts. Because the LID chat is therefore never deleted,
**every subsequent inbound message for that contact re-runs the same failing
merge and is dropped** — the user sees the conversation "stuck" after one
message, on every channel, even though the Baileys connection is perfectly
healthy and group messages keep flowing.

**Why it's invisible:** the upsert handler wraps each message in try/catch and
only logs `"Failed to process incoming message"`, so the loss is silent to the
user. The error to grep for is the `duplicate key ... chat_messages_chat_wa_message_id_unique`
on an `update chat_messages set chat_id`.

## The rule
1. Move only NON-colliding rows: `wa_message_id IS NULL OR wa_message_id NOT IN
   (SELECT wa_message_id FROM chat_messages WHERE chat_id = canonical AND
   wa_message_id IS NOT NULL)`. (The `IS NOT NULL` in the subquery is required —
   otherwise a NULL poisons `NOT IN` and nothing moves.)
2. Then `DELETE` the LID chat. The `chat_id` FK is `ON DELETE CASCADE`, so the
   true duplicates left behind are dropped, leaving exactly one canonical copy —
   no data loss.
3. Wrap the whole reconciliation in try/catch and only `logger.warn` on failure.
   Reconciliation is best-effort cleanup; it must NEVER abort persistence of the
   current inbound message (that was the actual mechanism of the silent loss).

## Recovery note
Messages dropped this way were never inserted — they're unrecoverable from the
DB (Baileys won't re-emit already-ACKed events). They survive only on the
phone/WhatsApp servers; practical recovery is the user re-sending. Stuck LID
chats self-heal on the next message after the fix, or can be merged manually
with the same NOT-IN-then-cascade-delete SQL.
