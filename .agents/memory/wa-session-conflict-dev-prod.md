---
name: WhatsApp Baileys dev/prod session conflict (kick-loop)
description: Symptom "syncing→disconnected→syncing" loop every ~12-20s is a WhatsApp 440 session conflict, not a code bug
---

A channel that flaps `syncing → disconnected → syncing` on a tight ~12-20s cycle (status flipping in the `channels` table, process PID stable, no crash, no "WA connection closed"-level fatal) is a **WhatsApp session conflict (DisconnectReason 440 / "replaced")**, NOT a reconnect-logic bug. Two Baileys sockets are alive on the SAME linked-device credentials, so WhatsApp kicks one; it auto-reconnects and kicks the other → endless loop on both sides.

**Why it happens here:** Baileys auth creds live on local disk (`.whatsapp-auth/<userId>/<channelId>/` via `useMultiFileAuthState`). Publishing snapshots the WHOLE filesystem (see deploy-repl-layer-filesystem), so the dev creds get copied into the live VM. When BOTH the editor/preview api-server and the published deployment run at once, they share one WhatsApp identity and fight. Dev/prod use separate DBs, but the conflict is at the WhatsApp-creds layer, not the DB.

**How to diagnose:** sample `SELECT status, updated_at FROM channels WHERE id=<n>` a few times a few seconds apart — rapid syncing/disconnected flip = conflict. The temporary diagnostic `logger.warn("WA connection closed", {statusCode, reasonName})` in the connection.close handler prints the real reason (440 vs 515 restartRequired vs 401 loggedOut).

**Fix (operational):** one WhatsApp number may be active in only ONE running environment. Stop the other (e.g. Deployments → Stop the live VM), then reconnect; it resumes without a new QR if creds are still valid and stays `connected`. Deleting/recreating the channel does NOT help.

**Durable fix (not yet built):** to run live + editor simultaneously, each environment needs its OWN pairing — either a different number per environment, or store creds in an env-scoped location that the publish snapshot doesn't share (object storage under a dev/ vs prod/ prefix). Keep `.whatsapp-auth/` out of the shared identity.

**Side note:** repeated conflict re-logins (dozens/min) risk a WhatsApp ban, so stop the loop promptly.
