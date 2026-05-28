---
name: Per-channel chat access scope
description: How per-user channel allow-list (user_channel_access) is layered without breaking team-wide features that share the channel switcher.
---

Per-user `user_channel_access` rows gate **chat visibility only** — not the channel switcher, and not flows/statuses/analytics/knowledge/products.

**Why:** the spec said "deny-by-default → empty switcher for users with zero rows" AND "scope = chats only, other surfaces stay team-wide". Those are internally inconsistent because the switcher is a single shared `X-Channel-Id` context used by every channel-scoped page. Filtering `/channels` for chat permissions silently hides those channels from flows/statuses/analytics too — breaking the team-wide guarantee. The chat-only guarantee is the stronger of the two product requirements, so the switcher stays full and the chats list goes empty (with deny-by-default semantics) when a restricted user lands on a forbidden channel.

**How to apply:**
- Filter inside chat-touching endpoints only: `GET /chats`, `authorizedChatWhere` (covers all `/chats/:id*` mutations and reads), and `POST /chats/open-by-phone`. Any new chat-touching endpoint must intersect `scope.channelIds` with `getAllowedChannelIds(uid)` and 404/empty-list on miss.
- Do NOT filter `GET /channels` or `resolveChannelScope` — those feed the shared switcher and the team-wide features.
- `setAllowedChannelIds` must validate channel ownership **inside** the same tx as the delete+insert, behind the `FOR UPDATE` on the users row, or a concurrent channel delete FK-fails the whole save.
- New supervisor/agent users get deny-by-default (zero rows = no chats). The initial rollout needed a one-time SQL backfill granting every existing supervisor/agent every channel in their tenant; without it, existing users would silently lose access on deploy.
