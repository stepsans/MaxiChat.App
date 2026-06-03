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

## Rule 3 — History sync must download media AND back-fill on conflict
Two coupled traps when ingesting `messaging-history.set`:

1. If `parseWaMessage` is called with `downloadMedia: false` for history, every historical row is persisted with `mediaUrl=null`. Operator sees the text/caption but every PDF / image / video is a dead placeholder.
2. Persisting via `onConflictDoNothing(waMessageId)` means a *later* history sync that finally has the file (or now has sender info) can't repair the existing row — the conflict silently no-ops.

**Why:** A history chunk is the only chance to capture that message's media keys; if you don't download then and don't back-fill on conflict, the media is lost until the user manually re-pairs and clears the row.

**How to apply:**
- Pass `downloadMedia: true` to `parseWaMessage` from the `messaging-history.set` loop, not just from `messages.upsert`. Sequential awaits in the loop already throttle the fetch storm.
- On a no-op conflict, follow up with an `UPDATE … SET col = COALESCE(col, $new)` for media (url/type/mime/filename), sender (jid/phoneDigits/name), and mentions. COALESCE guarantees we never clobber an already-good value.

## Rule 4 — JID suffix allowlist
`parseWaMessage` allows `@s.whatsapp.net`, `@lid`, and group JIDs. Drops `@broadcast`, `@newsletter`, `status@broadcast`. If WhatsApp introduces a new suffix (e.g. `@bot`), messages from those JIDs will be silently dropped here — revisit the allowlist if users report missing chats from new contact types.

## Rule 5 — Outbound sends must capture the WA message id for echo-dedupe
Any handler that sends a WA message itself (manual reply, quotation, sales-order summary, etc.) AND then inserts an `outbound` row into `chat_messages` must set `waMessageId = sock.sendMessage(...)?.key?.id` and insert with `onConflictDoNothing({ target: waMessageId })`. Baileys echoes every send back through `messages.upsert`, which also inserts the row — if your manual insert has a `null` waMessageId, the echo can't dedupe against it and the message appears twice in the dashboard.

**Why:** the echo and the manual insert are two independent write paths for the same message; the WA message id is the only shared key that lets `onConflictDoNothing` collapse them.

**How to apply:** Telegram has no echo, so its branch sets a synthetic `tg:<chatId>:<messageId>` key explicitly. For WA, capture the real `.key.id` from the send result (mirror `sendMediaToJid`, which returns it). Never leave the WA dedupe key null when you also insert the outbound row yourself.

## Rule 6 — Group author may be a privacy LID, not a dialable phone
In recent Baileys, a group message's author often arrives as a privacy **LID** in `msg.key.participant` (`@lid` suffix) whose numeric local-part is NOT a real phone number. The real number, when present, is in `msg.key.participantPn` (`@s.whatsapp.net`).

**Why:** Any feature that derives a phone number from the participant (e.g. "Balas pribadi" / "Kirim pesan" → open the member's 1:1 chat) will route to a bogus LID-keyed chat if it trusts `participant` blindly. The user-visible symptom: replying privately to a group member opens the wrong/empty personal chat.

**How to apply:**
- For group inbound, prefer `participantPn` (real `@s.whatsapp.net` JID). Only set the stored phone digits from a real phone JID; if only a LID is available, resolve it via `sock.signalRepository.lidMapping.getPNForLID(lid)` (defensive `as any` — the typed socket has minified prop names). If still unresolved, leave phone digits **null** rather than emitting LID digits, so the UI says "unknown number" instead of misrouting.
- Keep a canonical author id (`senderJid = phoneJid ?? firstCandidate`) for grouping/avatars; display falls back to `pushName`, so nulling the phone digits doesn't break grouping.
- Cache only **successful** LID→PN resolutions (not misses) per connection — the store learns mappings over time and the lookup is a cheap local read; caching nulls leaves a participant stuck as "unknown" until reconnect.
- The server parse fix only repairs **newly ingested** rows. Messages already in `chat_messages` keep the LID in `sender_phone_digits`, and the API exposes no `senderJid` — so the client must NOT trust a group message's stored phone for "Balas pribadi". Resolve it through the live group roster (`getGroupInfo` participants carry the real `phone` from `groupMetadata`): if the stored digits equal a participant's LID-JID digits, swap in that participant's real phone; guard that the resolved phone differs from the LID digits (the participant resolver may echo the LID back as `phone`), and refuse to act until the roster has loaded rather than open a stale LID.
