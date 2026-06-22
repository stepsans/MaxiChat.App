---
name: Baileys logout re-pair requires wiping creds
description: Why a "disconnected" WhatsApp channel can never re-pair from the Connect button unless the dead auth dir is wiped.
---

# Baileys logged-out channel can't re-pair without wiping creds

When a WhatsApp number is logged out (remotely from the phone, by WhatsApp,
or its on-disk creds go stale), the per-channel auth dir
(`.whatsapp-auth/<userId>/<channelId>/`, contains `creds.json` + thousands of
signal key files) is left in place. On the next `/connect` → `startBaileys`,
Baileys loads those creds and tries to **RESUME** the session instead of
emitting a pairing **QR**. The resume fails, `connection.update` fires
`connection: "close"` with `DisconnectReason.loggedOut` (401), and the channel
drops back to `disconnected` — **no QR is ever produced**. The Connect button
then appears to do nothing and the channel is permanently stuck.

**Rule:** Baileys only emits a `qr` event when there are NO valid creds on
disk. To re-pair a logged-out channel you MUST delete its auth dir first.

**Why:** `/disconnect` already wipes the auth dir (that's the manual recovery:
Disconnect → Connect shows a QR). But `/connect` and the plain `loggedOut`
close path did not, so a remote logout left the user with no in-app way to
reconnect.

**How to apply:**
- In the `connection === "close"` handler, branch on
  `statusCode === DisconnectReason.loggedOut`: wipe `authDirForChannel(...)`
  then restart `startBaileys` once so a fresh registration surfaces a new QR.
  Only the loggedOut code triggers the wipe — transient drops
  (network / restart-required 515 / etc.) must resume with the existing creds,
  never force a re-pair.
- Do NOT clear `channels.owner_phone` on logout — the channel↔number binding
  survives so re-pairing the SAME number restores its chat history.
- For an already-stuck channel (close already happened before the fix
  shipped), the dead auth dir must be removed once by hand to unstick it;
  remove ONLY that `<userId>/<channelId>` dir — sibling channels are live
  sessions and wiping them logs those numbers out.

## The wipe races a trailing `creds.update` → fatal unhandledRejection

The logout-wipe above introduced a crash: after `fs.rm(authDir)` deletes the
dir, Baileys can still emit ONE more `creds.update`. If `creds.update` is wired
as the bare `sock.ev.on("creds.update", saveCreds)`, that unawaited
`saveCreds()` does `writeFile(.whatsapp-auth/<u>/<c>/creds.json)` into the
now-deleted dir → `ENOENT`. The rejection is unhandled, the global
`unhandledRejection` handler exits the process, and api-server **crash-loops on
every start** (a conflict/loggedOut channel re-triggers it immediately). Symptom
in logs: `Fatal: unhandledRejection; exiting` + `ENOENT ... creds.json` right
after a `loggedOut`/`Stream Errored (conflict)` close.

**Rule:** never wire an unawaited promise-returning Baileys listener bare. Wrap
saveCreds so its write error can't escape:
`sock.ev.on("creds.update", () => void saveCreds().catch(logWarn))`.

**Why:** losing a creds write on a dead/re-pairing session is harmless, but an
uncaught write into a wiped dir takes down the whole API. Same class as the
media-stream and scheduler unhandledRejection crashes — any async Baileys/IO
side-effect off an event handler must own its own catch.
