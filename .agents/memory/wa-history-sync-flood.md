---
name: WhatsApp full-history-sync flood wedges process
description: Why Baileys syncFullHistory must stay off in prod, and the corrupt-pinned-timestamp DB crash that rides along with history dumps.
---

# WhatsApp history-sync flood wedges the whole process

`syncFullHistory: true` makes WhatsApp dump the ENTIRE chat history (observed:
`messaging-history.set ... messages=5000` batches) on EVERY (re)connect. Each
history message triggers a media download (many 403 from expired `.enc` URLs) +
link-preview fetch (multi-second external calls) + DB writes. Under a
conflict/replaced reconnect loop (same WA creds connected in two places) this
repeats and progressively congests the Node event loop until the process
**wedges** — alive at TCP (TLS handshake completes) but never returns an HTTP
response and stops emitting logs. On a Reserved VM (`gce`) the edge LB then has
no responsive backend, so the public domain hangs (curl `http=000`) and uptime
monitoring records continuous outage.

**Rule:** keep `syncFullHistory: false`. Leave `shouldSyncHistoryMessage` as
`() => true` so the small RECENT sync still catches up missed messages and
`isLatest` still promotes the channel out of "syncing". Returning `false`
unconditionally drops reconnect catch-up (data gaps) and can leave status stuck
on "syncing" for the 120s fallback.

**Why:** the flood, not the catch-up, is the killer; full backfill is what
produces the thousands-of-messages dumps.

## Corrupt `pinned` timestamp crashes the history-sync txn
WhatsApp/Baileys occasionally sends a garbage `pinned` value; unbounded
`new Date(p * 1000)` yields an absurd date (year `041970`) that Postgres rejects
with `time zone displacement out of range`, rolling back the whole history-sync
transaction. Clamp `pinned` to a plausible epoch (`<= 2100-01-01`) before
constructing the Date in `extractChatListMeta`.

## History-media downloads must be age-gated (~14-day WA window)
Even with `syncFullHistory: false`, the recent-history `messaging-history.set`
handler used to call `parseWaMessage(..., downloadMedia=true)` for EVERY history
message. WhatsApp only allows media re-download for ~14 days, so older `.enc`
URLs return 403 — attempting them is pure waste that floods prod logs and
saturates CPU/network, stalling the dashboard's API calls (symptom: published app
"spins forever", but process is STABLE/no restart = saturation, not OOM-crash).

**Rule:** in the history handler, gate the download flag on message age
(`Date.now() - toEpochMs(msg.messageTimestamp) <= 14d`); older messages persist
metadata only (placeholder, `mediaUrl: null`). Treat a missing/zero timestamp as
"too old" (skip) — do NOT let `toEpochMs`'s `Date.now()` fallback re-open the
flood. Live `messages.upsert` keeps downloading (fresh URLs) and is untouched.

**Why:** old media is unrecoverable regardless, so the only effect of trying is
the flood; placeholders for >14d media are an acceptable, invisible tradeoff.

### The deeper cost is per-message DB work, not just media
Age-gating media alone was NOT enough: on every reconnect (WhatsApp 515
`restartRequired`) WhatsApp re-dumps the RECENT history as many back-to-back
5000-message batches, and the handler did one `parseWaMessage` DB round-trip per
message (dedup/insert) — even though `ingested` was ~0 because they were already
stored. That per-message DB storm on the single Node event loop is what makes the
published dashboard "spin" (every API call jumps to 1–3s; process stays STABLE,
no restart = saturation not crash).

**Rule:** in the history handler, on RECONNECT only
(`isReconnect = connPreSyncCutoff.size > 0`), `continue` (skip `parseWaMessage`
entirely) for messages older than a ~14-day catch-up window. First-time sync
(`isReconnect=false`) still ingests everything so a fresh pairing populates chats.
Keep `status@broadcast` handling and the `isLatest` "syncing"-promotion BEFORE/AFTER
the gate untouched, and never touch the live `messages.upsert` path.

**Trade-off (accepted):** a reconnect after >14 days of downtime won't backfill
the older missed messages — rare, and those are already media-expired anyway.

## Diagnosing a "site down but process looks alive" hang
- `curl -sv https://<domain>/` → TLS connects + cert OK but no `HTTP/` line, then
  timeout (`http=000`) = backend wedged, not a DNS/TLS/domain problem.
- Deployment logs going completely silent (no scheduler ticks either) at the same
  time = event loop blocked, not a crash (a crash would re-emit "starting up").
- Fix = redeploy/restart to get a fresh process; ship the code fix so it doesn't
  recur on the next reconnect.
