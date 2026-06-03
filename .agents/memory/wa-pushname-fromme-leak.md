---
name: WA fromMe pushName leaks owner name onto contacts
description: Why outbound WhatsApp messages must not use msg.pushName to name a 1:1 contact.
---

# fromMe pushName leaks the owner's name onto customer chats

On a Baileys `messages.upsert` where `key.fromMe` is true, `msg.pushName` is the
OWNER's own WhatsApp display name — NOT the remote contact's. Using it to set
`chats.contactName` (on chat create OR the "name is still a bare number" update)
labels every customer the operator messaged first with the operator's name
(symptom: many distinct numbers all showing the same owner-like display name).

**Rule:** in the 1:1 branch of message parsing, only adopt `msg.pushName` when
`!fromMe`; otherwise fall back to the raw number. A contact's real name must come
from their own INBOUND messages or a `contacts.upsert`/`contacts.update`.

**Why:** pushName is the sender's self-name; for fromMe the sender is us.

**Cleanup of already-corrupted rows:** reset `contact_name` to the bare digits
(no `+`) so the re-resolution guards (`contactName = rawNumber OR IS NULL`) let a
future inbound message repopulate the correct name. Do NOT reset the owner's own
self-chat (phone == channel.owner_phone) — that name is legitimately the owner.

**The code guard alone does NOT heal existing corruption — cleanup is a SEPARATE
step that must be run per channel after the fix lands.** A row already named with
the owner's display name can never self-heal: its `contact_name` is no longer a
bare number, so every re-resolution guard (`= rawNumber OR IS NULL`) skips it.
Shipping the guard fixes one channel's *new* messages but leaves every other
channel's pre-fix rows stuck. Find leaked rows channel-agnostically by joining
each channel's owner self-chat name: a 1:1 chat (`phone_number LIKE '+%'`) whose
`contact_name` equals the owner self-chat's name AND whose phone != the owner's
is a leak. Reset those to `ltrim(phone_number,'+')`.
