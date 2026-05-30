---
name: Product send/quotation scope is user-scoped, not channel-scoped
description: Why the Products/Order sidebar tabs must NOT channel-filter products client-side, unlike the Shortcut tab.
---

`POST /chats/:id/product` and `POST /chats/:id/quotation` resolve products by the chat
owner's `userId` only — they ignore each product's `channelIds`. The Shortcut send
endpoint, by contrast, DOES enforce per-channel scope server-side.

**Rule:** Client UI for sending products (Products tab, Order/quotation tab) must filter
products by search only, never by `chat.channelId`. Channel-filtering hides products the
server would happily send.

**Why:** `Product.channelIds` exists in the schema/OpenAPI ("empty = global") but the send
paths never check it. Mirroring the shortcut tab's channel filter onto products is a
discoverability regression — valid sendable products disappear from the list.

**How to apply:** If product sending is ever meant to be channel-scoped, tighten BOTH send
endpoints server-side first (load channel assignments, reject out-of-scope), then add the
client filter back. Keep client and server scope authority in lockstep — don't filter on
one side only.
