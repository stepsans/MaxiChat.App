---
name: Outgoing WA message signatures
description: How and where outgoing WhatsApp messages get tagged with `_<sender>_` italic signatures, and which paths intentionally skip signing.
---

Every outgoing WhatsApp message in MaxiChat is signed with a trailing italic tag (`\n\n_<sender>_`) so the recipient can tell whether a human agent, the chatbot flow, or the AI produced it. WhatsApp italic is single underscores.

The central helper is `artifacts/api-server/src/lib/sender-tag.ts` (`withTag`, `resolveAgentTag`, `stripTrailingTag`, `CHATBOT_TAG`, `AI_TAG`). All signing happens at send-time, not in stored config.

**Tag matrix:**
- Human agent reply (manual reply, media caption, product send) → `_<FirstName>_` resolved from `users.name` (first word) or email local-part fallback.
- Chatbot flow text/caption → `_Chatbot_`.
- AI-generated auto-reply → `_powered by AI_`.
- Operator-authored `settings.fallbackMessage` (canned, used when AI fails) → **unsigned**. It's not the AI's output and not a human reply, so attributing it to either would mislead.
- vCard sends and product follow-up URL-only messages → unsigned (no body to attach a signature to without making it ugly).

**Why store the tag in `chat_messages.content` and `chats.last_message`:** the dashboard mirrors what the recipient actually sees on WhatsApp; storing the un-tagged version would diverge the two views.

**Why:** users wanted clear attribution per role so customers know if they're talking to a human, a flow, or AI.

**How to apply:** when adding a new outbound send path, import from `lib/sender-tag.ts` and tag the text **before** both the `sock.sendMessage` call and the `chat_messages` insert. Use the same tagged string for `chats.last_message`. If you store the message before sending (DB-first pattern like `/chats/:id/reply`), tag at the insert so whatever later picks up the row sends the signed text.

**AI history gotcha:** `generateAiReply` feeds the last 10 messages back to the LLM as conversation history. Outbound rows must be passed through `stripTrailingTag` first — otherwise the model sees its own past `_powered by AI_` (and human `_Stephen_`) signatures and starts either roleplaying as that agent or emitting its own signature, which `withTag` then double-tags. Inbound rows are passed through as-is.

**Image-only sends:** even when there's no caption (agent attaches a file with no text, or a flow image-node with no text), we send a caption consisting of just the signature. This is intentional — the alternative is unattributed media.
