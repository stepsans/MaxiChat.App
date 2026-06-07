---
name: WhatsApp profile-pic refresh must include stale URLs, not just nulls
description: Why chat-list avatars "disappear" over time and the correct opportunistic-refresh condition.
---

# Cached WA profile-pic URLs expire — refresh stale rows, not only null ones

WhatsApp profile-picture URLs from `sock.profilePictureUrl()` are token-signed
and expire after a while. Once a cached URL expires the browser `<img>` 403s,
`onError` fires, and the avatar falls back to the generic glyph — so photos
"disappear" from chats that previously had them.

`refreshChatProfilePic` has a split TTL (success ≈2h to re-fetch fresh URLs,
failure ≈12h to back off privacy/no-pic accounts). That success TTL exists
precisely to replace stale-but-present URLs.

**The trap:** the opportunistic refresh in `GET /chats` originally only fired
when `!c.profilePicUrl` (null-only), which silently disabled the success-TTL
path — present-but-expired rows were NEVER refreshed.

**Rule:** the chat-list opportunistic refresh must select rows via
`isProfilePicRefreshDue(chat)` (covers null AND past-TTL present URLs), not a
null check. Cap fetches per request (budget ~30) so a restart (when many rows
are simultaneously due) doesn't burst the WhatsApp servers.
**Why:** without this, avatars decay to fallback icons cluster-wide every few
hours and only the manual per-chat "refresh avatar" button fixes them.
**How to apply:** any new caller that opportunistically refreshes avatars must
gate on the TTL predicate, never on `profilePicUrl == null`.
