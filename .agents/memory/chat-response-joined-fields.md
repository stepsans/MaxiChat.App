---
name: Chat-returning endpoints must attach joined/computed fields
description: Why every chat-returning handler (not just list/get) must append labels and other non-column fields to match the Chat OpenAPI schema.
---

The `Chat` / `ChatWithMessages` OpenAPI schemas include fields that are NOT plain
columns on `chatsTable` — notably `labels[]` (a join via `chat_labels` +
`customer_labels`). `labels[]` items are the full `CustomerLabel` shape, which
**requires `createdAt`** (not just id/name/color).

**Rule:** Every endpoint that returns a chat object must append `labels` via
`fetchLabelsForChats([id])` AND the label serializer must include every required
`CustomerLabel` field. This applies to ALL chat-returning handlers, not just
`GET /chats` and `GET /chats/:id`:
- `PATCH /chats/:id`
- `PATCH /chats/:id/assign`
- `POST /chats/:id/takeover`
- `PUT /chats/:id/labels`

**Why:** `assign`/`takeover` handlers spread `...updated` (the raw DB row) into
the response. The DB row has no `labels` and the label sub-serializer is easy to
under-fill (omitting `createdAt`). TypeScript will NOT catch this — responses are
not statically checked against the generated zod schema — so the drift is silent
until a strict client or response-validation middleware rejects it.

**How to apply:** Whenever the `Chat` schema gains a new non-column field, grep
for every `res.json({ ...updated` in `artifacts/api-server/src/routes/chats.ts`
and append the new field in lockstep. Keep `SerializedLabel` in sync with the
required fields of the `CustomerLabel` OpenAPI schema.
