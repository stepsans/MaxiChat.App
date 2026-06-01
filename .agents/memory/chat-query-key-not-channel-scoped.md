---
name: Chat list query key is not channel-scoped
description: Why per-channel client-side diffing of the chat list needs a pending-baseline guard across channel switches
---

# Chat list query key is not channel-scoped

`useListChats(getListChatsQueryKey())` uses a single, channel-agnostic query
key. The active channel is selected server-side via a request header (driven by
`useActiveChannel().activeChannelId` through the fetch interceptor), and channel
switches refetch the SAME cache key rather than keying a new cache entry.

**Why this bites:** any client feature that diffs the chat list across poll
cycles (e.g. the incoming-chat notification sound) sees, immediately after a
channel switch, the PREVIOUS channel's still-cached payload before the refetch
for the new channel lands. Comparing the new channel's payload against a
baseline captured at switch time (or vice-versa) compares unread counts across
two different channels and produces false positives (the new channel's
pre-existing unreads look "new").

**How to apply:** never re-baseline such a diff using `activeChannelId` changing
alone. Arm a "pending baseline" flag on channel change AND on first mount, then
in the chats-data effect silently adopt the first payload that arrives while the
flag is set (clearing it) before doing any comparison. Keep the chats-data
effect dependent on `chats` only, and the arming effect dependent on
`activeChannelId` only.
