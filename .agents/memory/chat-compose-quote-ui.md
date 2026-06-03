---
name: Chat compose/quote/link-preview UI conventions
description: Non-obvious couplings in ConversationPane for link previews, reply quotes, and transient per-message UI state.
---

# Link preview must be normalized client-side

The link-preview server route parses the `url` query with `new URL(...)` and rejects scheme-less inputs. The frontend linkifier happily turns bare domains (`www.example.com`, `example.com`) into clickable links, so the preview fetch MUST send `hrefForLink(rawLink)` (which prepends `https://`), not the raw matched text.

**Why:** otherwise bare/www links render as clickable anchors but never get a preview card — a silent half-feature.
**How to apply:** any code calling `getLinkPreview`/`/api/link-preview` normalizes the URL first; keep the card's `href` and its fetch URL derived from the same `hrefForLink()`.

# Transient per-message UI state must reset on chat switch

`replyTo` (quote bar), `reactionTarget` (open emoji bar), and select-mode (`selectMode`/`selectedIds`) are per-conversation and must be cleared in a `useEffect(..., [chatId])`.

**Why:** a stale `replyTo` carries a `quotedMessageId` from the previous chat; the send endpoint silently ignores a foreign quote id, so the reply downgrades to plain text with no visible error. Select-mode selections would also leak across chats.
**How to apply:** "Balas pribadi" / "Kirim pesan" navigate to a different chat, so they must NOT pre-set `replyTo` before navigating — the chatId-change effect would clear it anyway. Just navigate.
