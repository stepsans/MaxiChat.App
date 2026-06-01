---
name: Group endpoint channel binding
description: Which WhatsApp channel socket each group endpoint must use (existing-group ops vs create).
---

Group features split into two socket-resolution rules:

- **Existing-group reads/mutations** (group-info, attachments, common-groups, add-participants) act on a group that already lives on a *specific* channel. Resolve the socket via `getSockForChannel(chat.channelId)` after `loadOwnedChat(...)` — never the primary channel, or you query/mutate on the wrong account when the chat belongs to a non-primary channel.
- **Group creation** (`POST /groups`) has no existing chat row, so it uses the owner's PRIMARY channel (`getPrimaryChannelForUser`), same as all WA outbound sends.

**Why:** mirrors the dual-channel-send rule — a chat is bound to one channel, but "new" actions with no chat context default to primary. Mixing these silently targets the wrong WhatsApp account.

**How to apply:** any new endpoint that takes a `:id` chat param and touches Baileys must go `loadOwnedChat` → `getSockForChannel(chat.channelId)`. Only channel-less "create new" actions use the primary channel.

Other gotchas from this feature set:
- Starred is MaxiChat-internal (`chat_messages.is_starred`), NOT synced from the phone; scope star update/query by both messageId AND the authorized chat.id.
- After adding a column to a shared DB schema, run `pnpm run typecheck:libs` (rebuild composite libs) before the new field appears in db types downstream.
- Phone arrays validated as `string[]` must be re-guarded AFTER digit-normalization (`filter(Boolean)`); an all-garbage payload like `["abc"]` passes zod but normalizes to `[]` — reject with 400 before calling Baileys.
- Common-groups deep links must use the real route `/chats/:id` (plural), not `/chat/:id`.
