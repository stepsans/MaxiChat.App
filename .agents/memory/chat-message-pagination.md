---
name: Chat message pagination (recent window + keyset history)
description: How chat threads page messages — why GET /chats/:id is capped, why history is a separate query-only endpoint, and the autoscroll-with-cap trap.
---

# Chat message pagination

A polled `GET /chats/:id` must NOT return a chat's full message history. The
endpoint refetches every few seconds; a busy group has tens of thousands of
rows, so shipping all of them per poll is what makes opening such chats hang.

## The pattern
- `GET /chats/:id` returns only the most-recent window (currently 200): fetch
  newest-first with `limit window+1`, set `hasMoreMessages = fetched > window`,
  then reverse to chronological ASC for the client.
- Older history is a SEPARATE endpoint `GET /chats/history?chatId=&before=&limit=`
  that keyset-pages strictly-older rows via tuple comparison
  `(created_at, id) < (cursor.created_at, cursor.id)` (descending scan + reverse).
  Resolve the `before` cursor's `(created_at,id)` by looking it up scoped to the
  owned chat — never trust a raw message id as a cross-chat cursor.
- Requires the `(chat_id, created_at, id)` composite index or it's a full scan.

**Why query-only history (no path param):** putting both a path param and query
params on the same OpenAPI operation makes orval emit two `GetChatParams` types
(zod path-validator vs query-types) that collide in the api-zod barrel (TS2308).
A standalone query-only operation sidesteps this entirely. See also
`openapi-inline-body-codegen-collision.md`.

**Express route ordering:** register the literal `/history` route BEFORE `/:id`,
or `/chats/history` is matched by `/:id` (id="history" → NaN → 400). Same rule as
`/chats/open-by-phone`.

## Frontend gotchas
- Merge recent window + paged-in older messages, dedupe by id, sort by
  `(createdAt, id)` (same total order the server pages by).
- **Autoscroll must key on the NEWEST message id, not `messages.length`.** Once a
  chat hits the recent-window cap the length stops changing even as new messages
  stream in on poll, so a length-keyed autoscroll effect silently stops firing.
  Keying on newest id also means prepending older history (which doesn't change
  that id) correctly does NOT yank the viewport to the bottom.
- Restore scroll on prepend: capture `scrollHeight`/`scrollTop` before, then set
  `scrollTop = newScrollHeight - prevHeight + prevTop` in a rAF after state updates.
- In-chat client-side search now only scans loaded messages (recent + manually
  paged), not the full thread — a deliberate tradeoff of lazy history.
