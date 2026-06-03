---
name: Baileys media download crashes process via async stream error
description: Why a WhatsApp media 403/socket-close can take down the whole API despite a try/catch, and how it's guarded.
---

# Baileys media download can crash the whole API process

`downloadMediaMessage` (Baileys) fetches WhatsApp media over **undici**. When a
media server closes the socket mid-stream — extremely common during history sync
of expired media that first 403s from `mmg.whatsapp.net` — undici emits an
`'error'` event on the response **Readable asynchronously**, *after* the
`await downloadMediaMessage(...)` promise has already settled.

**Why the try/catch doesn't help:** the `try/catch` around the download only
catches the rejected promise. The later stream `'error'` event has no listener,
so Node turns it into an `uncaughtException` → the entire api-server process
exits (exit code 1). Symptom for users: the api-server workflow shows FAILED and
unrelated features silently break — e.g. the AI Review group selector shows
"Belum ada grup. Pastikan WhatsApp terhubung & ada chat grup masuk." because the
groups query hits a dead server.

**Guard:** `artifacts/api-server/src/index.ts` installs `process.on('uncaughtException')`
+ `'unhandledRejection'` that swallow ONLY recoverable undici/socket errors
(`UND_ERR_SOCKET`, `UND_ERR_ABORTED`, `ECONNRESET`, `ETIMEDOUT`, or
`TypeError: terminated` / `cause.code` matches) and log them as warnings.
Anything else still logs + `process.exit(1)` so real bugs aren't masked.

**How to apply:** keep the allow-list narrow. Do NOT broaden the handler into a
catch-all that swallows every uncaughtException — that hides real crashes. If you
see "Belum ada grup" or other empty-data symptoms, check whether the api-server
workflow crashed first before chasing the feature itself.
