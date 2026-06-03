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
