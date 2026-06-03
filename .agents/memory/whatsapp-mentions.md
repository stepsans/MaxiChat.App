---
name: WhatsApp group @mentions
description: How Baileys group mentions wire up (text token + JID array) and the client-side draft→send token model that keeps them robust.
---

# WhatsApp group @mentions

## Baileys mechanics
A mention only fires when BOTH are present in `sock.sendMessage`:
- the body text contains an `@<jidLocalpart>` token, and
- a `mentions: string[]` array carries the matching FULL JIDs.

The digits in the `@<...>` token must equal the JID local part to actually
notify. Works for real-phone (`@s.whatsapp.net`) and LID (`@lid`) participants.
Local part = `jid.split("@")[0].split(":")[0]` (strip device suffix).

**Why:** mentions are group-only; on 1:1/Telegram the server must drop the
`mentions[]` rather than forwarding arbitrary JIDs to Baileys.

## Client draft→send token model
The compose box is a plain textarea, so we show `@<label>` (name) to the
operator and convert to `@<digits>` only at send. Picks are tracked as
`{label, jid, digits}`.

**How to apply (rewriter must be):**
- **boundary-anchored** — match `(^|\s)@(label)(?=$|\s|[^\w])`, never a naive
  substring replace, or `@Adi` rewrites inside `@Adianto`.
- **collision-safe** — two members with the SAME display label must each be
  consumed once, left-to-right (mark picks used), or both collapse onto the
  first pick's digits and the second is never notified.
- deleted tokens are silently dropped (no stale mention JID on send).

Outbound `@<digits>` tokens render back as names via a digits→name map built
from BOTH message history and the live group roster (groupMetadata), keyed by
JID localpart AND resolved real phone.
