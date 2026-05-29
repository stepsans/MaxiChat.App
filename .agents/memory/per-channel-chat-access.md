---
name: Per-channel channel access scope
description: How per-user channel allow-list (user_channel_access) scopes the channel switcher and every per-channel surface for supervisors/agents.
---

Per-user `user_channel_access` rows gate the **whole channel switcher** for supervisor/agent: they see ONLY the channels assigned to them. super_admin always sees every channel owned by their tenant (including channels created by their supervisors/agents). Deny-by-default: zero rows = empty switcher.

**Why:** the product owner explicitly required "User/Supervisor only see channels assigned to them; Super Admin sees all." The switcher is a single shared `X-Channel-Id` context used by every channel-scoped page, so scoping the switcher naturally scopes chats/flows/statuses/analytics together — which is the intended behavior. (This REVERSES an earlier short-lived "chat-only" interpretation; do not reintroduce a full team-wide switcher for restricted users.)

**How to apply:**
- The single source of truth is `getAllowedChannelIds(sessionUid)` (super_admin → all owned; others → exact `user_channel_access` rows, tenant-validated via join). All channel resolution funnels through it.
- In `channel-context.ts`: `listOwnedChannels`, `loadOwnedChannel`, `resolveActiveChannel` (reject forbidden `X-Channel-Id` header; pick lowest-id ALLOWED channel as primary), and `resolveChannelScope` ("all" mode intersects with allowed) all filter by it. Any NEW channel resolver must do the same or it becomes a bypass.
- `setAllowedChannelIds` must validate channel ownership **inside** the same tx as the delete+insert, behind the `FOR UPDATE` on the users row, or a concurrent channel delete FK-fails the whole save.
- Deny-by-default operational risk: existing supervisors/agents with empty `user_channel_access` see ZERO channels until a super_admin assigns them via the "Akses Channel" card (Permission per User tab). Communicate this or bulk-assign before relying on it in prod.
