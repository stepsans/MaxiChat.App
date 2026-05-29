---
name: Incoming sticker media handling
description: How WhatsApp stickers flow through the chat media pipeline and a non-obvious auto-reply consequence.
---

# WhatsApp sticker handling

Stickers (Baileys `stickerMessage`) are webp images. They reuse the exact image
media path in `parseWaMessage`: set `mediaKind="sticker"` (mime `image/webp`) so
they go through `downloadMediaMessage -> saveBufferToMedia`. The `media_type`
column is free text (no enum / no migration) — adding a new media kind only needs
the `IncomingMedia` union, the `mediaKind` local, `buildPreview`, and the
frontend render branch.

**Why it matters / gotcha:** sticker-only inbound messages have empty
`messageContent`. `maybeTriggerAutoReply` early-returns on `if (!messageText.trim())`,
so stickers do NOT trigger AI/flow auto-reply. This is intentional for the
display feature; if product ever wants AI to react to stickers, add a media-aware
signal rather than re-introducing visible placeholder text in `content`.
