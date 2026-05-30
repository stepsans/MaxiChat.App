---
name: Channel-scope must be re-checked on resource send-actions
description: Shared resources (shortcuts/products/knowledge) carry per-channel assignments; any new action that USES one in a chat must re-enforce that scope, not just owner scope.
---

Shared resources (text shortcuts, products, knowledge entries) have per-channel
assignment join tables (`text_shortcut_channels`, `product_channels`,
`knowledge_entry_channels`). Semantics: **no rows = global** (usable on any of the
owner's channels); **one or more rows = restricted** to exactly those channels.
The wire shape is `channelIds: number[]` where `[]` means global.

**Rule:** any endpoint that *acts on* such a resource inside a specific chat (e.g.
`POST /chats/:id/shortcut`) must enforce BOTH:
1. owner scope — resolve the resource's owner via `chat.channelId -> channels.userId`, never via the session, and match `resource.user_id`; and
2. channel scope — load assignments via `loadChannelIdsBatch(kind, [id])`; allow only when the set is empty (global) OR includes `chat.channelId`.

**Why:** owner scope alone blocks cross-tenant access but still lets a same-tenant
shortcut restricted to channel A be sent in channel B, silently violating the
scoping the resource CRUD already enforces. This is an intra-tenant authorization
consistency break, not just a UX gap.

**How to apply:**
- Server is the authority (return 404, not 403, to avoid leaking existence). Mirror the same filter client-side for UX (hide out-of-scope rows) — the chat's `channelId` is needed there, so the `ChatWithMessages` contract carries `channelId`.
- This is distinct from `user_channel_access` (per-user channel allow-list, see per-channel-chat-access.md) — that gates which channels a person sees; this gates which shared resources a channel may use.
