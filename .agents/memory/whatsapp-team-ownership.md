---
name: WhatsApp team ownership model
description: How team WhatsApp pairing is shared across super_admin / supervisor / agent users in MaxiChat, and the rule every per-user WA helper must follow.
---

Only the **super_admin** (users.parent_user_id IS NULL) pairs a WhatsApp number. Invited team members (**supervisor**, **agent**, identified by users.parent_user_id pointing at the super_admin) do NOT pair their own — they inherit the parent's live Baileys socket, on-disk auth dir, and `whatsapp_session` row.

**Rule:** Any per-user WhatsApp helper in `routes/whatsapp.ts` that touches `getCtx(userId)`, the auth dir, or the `whatsapp_session` row must first resolve the caller's owner userId via `resolveOwnerUserId(userId)` from `lib/seed.ts` (returns `COALESCE(parent_user_id, id)`, process-cached). Otherwise invited members get an empty ctx and the UI reports "disconnected" / re-prompts for QR.

**Why:** Pairing state (socket, creds, session row) is keyed per-userId by design so multiple super_admins can run parallel WA accounts. Without owner resolution, an invited member's userId has no socket and no session row, so /status returns disconnected and send paths throw "WhatsApp is not connected" — even though the team's number is live under the parent.

**How to apply:**
- Data scoping stays split: tenant-wide data (chats, messages, products, statuses) is scoped by `ownerPhone`; per-agent visibility (e.g. `assignedUserId` on chats) stays keyed on the caller's own userId, NOT the resolved owner. Don't conflate the two.
- Mutating WA-account-level state (pair, disconnect, edit own bio/profile photo) must be gated to the owner via `isWhatsappOwner(userId)`; read paths (status, fetch bio) are fine for invited members.
- `ownerUserIdCache` assumes `parent_user_id` is immutable (only set at invite-accept). If a re-parent / team-transfer feature is ever added, drop or invalidate the cache — otherwise stale entries route a moved user's traffic to the wrong owner until process restart. Parent immutability is NOT enforced at the DB layer.
