---
name: Self-delete cascade requirements
description: Why DELETE FROM users alone is insufficient for tenant teardown in this schema.
---

A super_admin owns: invited team members (`users.parent_user_id`), channels, and many per-user/per-channel resources (chats, statuses, settings, flows, shortcuts, knowledge, products, ...). A single `DELETE FROM users WHERE id = $1` only works correctly if every owning column has `ON DELETE CASCADE` (or `SET NULL` for nullable assignment columns like `chats.assigned_user_id`).

**Why:** Drizzle schemas in this repo historically declared `integer("user_id").notNull()` / `integer("channel_id").notNull()` without `.references(...)` — partly to avoid perceived cross-file circular imports. Result: deleting a user left orphan rows that surviving sessions could still reach via owner-id scoping (`getEffectiveOwnerUserId` falls back to the raw session id).

**How to apply:**
- When adding any new table keyed by `user_id` or `channel_id`, add `.references(() => usersTable.id|channelsTable.id, { onDelete: "cascade" })` from day one. Nullable assignment-style FKs → `set null`.
- `users.parent_user_id` is a self-FK and needs `(): AnyPgColumn => usersTable.id` cast.
- Cross-file imports `whatsapp.ts → channels.ts → auth.ts` and `chatbot.ts → channels.ts` are safe (no cycle); the old "circular reference" comments are obsolete.
- Pair every self-delete/admin-delete endpoint with `requireAuth` that re-checks the user row exists + is active, or stale session cookies bypass the cascade.
