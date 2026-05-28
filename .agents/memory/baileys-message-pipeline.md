---
name: Baileys messages.upsert pipeline pitfalls
description: Silent message-loss traps in the Baileys incoming-message pipeline (event types, epoch guards). Read when chats appear "putus" / missing on the dashboard but exist on the WhatsApp phone.
---

# Baileys messages.upsert / messaging-history.set silent drops

## Rule 1 — Accept all real `messages.upsert` types
Baileys emits at least four types on `messages.upsert`:
- `notify` — brand-new live message
- `append` — catch-up during sync
- `prepend` — **older** message being backfilled after the initial history sync
- `replace` — edited / replacement message

**Why:** Filtering to just `notify` + `append` silently drops `prepend` (= missing older messages in our DB even though the phone has them) and `replace` (= edits never reflected). User-visible symptom: "chat putus" — gaps in the conversation only on the dashboard side.

**How to apply:** In every `messages.upsert` handler, accept all four types. If a future Baileys version adds another real message type, prefer logging unknown types over hard-dropping them.

## Rule 2 — Epoch guard must be `continue`, not `return`, mid-loop
The pattern `if (myEpoch !== ctx.epoch) return;` placed inside a `for (const msg of messages)` loop will drop the **rest of the batch** if the WhatsApp socket flickers mid-loop. Baileys won't re-emit those events (they were already ACKed to the server), so the messages are lost forever — and `onConflictDoNothing` on `waMessageId` would prevent them coming back even if they were.

**Why:** Persistence only needs the captured `ownerPhone` / `userId` from the closure, which are still safe after an epoch flip. The only thing genuinely unsafe after a stale epoch is **sending** something back (auto-reply / outgoing send) on the now-defunct socket.

**How to apply:**
- Keep one epoch check at the top of the handler (safe to `return` — nothing to lose).
- Inside per-message loops, do not gate persistence on epoch at all.
- Gate only the outbound-send step (`maybeTriggerAutoReply`, manual replies, presence updates) with the epoch check — and use `continue` so the rest of the batch still persists.
- Same rule applies to `messaging-history.set` ingestion loops.

## Rule 3 — JID suffix allowlist
`parseWaMessage` allows `@s.whatsapp.net`, `@lid`, and group JIDs. Drops `@broadcast`, `@newsletter`, `status@broadcast`. If WhatsApp introduces a new suffix (e.g. `@bot`), messages from those JIDs will be silently dropped here — revisit the allowlist if users report missing chats from new contact types.
