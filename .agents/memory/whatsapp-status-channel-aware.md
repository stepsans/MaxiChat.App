---
name: Legacy /whatsapp/* endpoints are kind-agnostic via resolveActiveChannel
description: Why the legacy /whatsapp/status|connect|disconnect handlers must guard channel.kind === "whatsapp" after switching to resolveActiveChannel.
---

The legacy single-channel `/whatsapp/status`, `/whatsapp/connect`, `/whatsapp/disconnect`
handlers were rewired to resolve the request's channel via `resolveActiveChannel(req)`
(channel-context.ts) instead of forcing the owner's primary channel. This is what makes
an invited member's dashboard widgets show THEIR assigned number and lets them
connect/disconnect only their own channel (access enforced by `getAllowedChannelIds`).

**Rule:** `resolveActiveChannel` / `listOwnedChannels` are KIND-AGNOSTIC — they return
WhatsApp, Telegram, and any future channel kinds. Any WhatsApp-only endpoint that uses
them MUST guard `channel.kind === "whatsapp"` (mirror the 400 in
`channels.ts` `POST /:id/pair`). For the WA status widget, fall back to the first
allowed WhatsApp channel when the selected channel is non-WA / "all" / none.

**Why:** without the guard, selecting a Telegram channel in the switcher and hitting
`/whatsapp/connect` would spin up Baileys on a Telegram row (or `/disconnect` would wipe
its auth dir) — corrupting a non-WA integration. Caught in code review.

**How to apply:** ctx/auth-dir keying uses `channel.userId` (the tenant owner id, since
channels are owned by the super_admin) + `channel.id` — the same key
`startBaileys`/`getCtxByChannel`/`authDirForChannel` use everywhere, regardless of which
team member triggers the action.
