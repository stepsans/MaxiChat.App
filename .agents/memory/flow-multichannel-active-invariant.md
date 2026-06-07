---
name: Flow per-channel active invariant
description: Why "max 1 active flow per channel" can't be a DB unique index once flows are many-to-many with channels, and where the invariant must be re-enforced.
---

Chatbot flows are owner-scoped and assigned to channels via a join table (no rows = global/all channels), mirroring products/knowledge/shortcuts. The product rule is "at most one active flow per channel", but two active flows on *disjoint* channel sets are allowed.

**Rule:** the invariant is enforced in application code (overlap-deactivation), NOT a DB constraint.
**Why:** the old single `channel_id` design used a partial unique index (`channel_id WHERE is_active`). With a many-to-many assignment there is no single column to make unique, and "global overlaps everything" is set-overlap logic a unique index can't express.

**How to apply:**
- The overlap-deactivation helper (deactivate every OTHER active owner flow whose channel set intersects the target's; global ∩ anything = overlap) must run on BOTH activate AND on PATCH when `channelIds` changes. Forgetting PATCH is a real single-user bug: assign A→ch1 active, B→ch2 active (both allowed), then edit B to add ch1 → both active on ch1.
- Wrap each mutation in a transaction holding `pg_advisory_xact_lock(ownerUserId)` so concurrent activate/reassign for the same owner serialize (no DB constraint to catch a race).
- Runtime selection (whatsapp.ts Case B) must still be deterministic (`ORDER BY updatedAt DESC, id DESC`) and prefer a channel-assigned flow over a global one — defensive, in case overlap ever slips through.
- Channel deletion must NOT delete flows (join rows cascade instead), same as products.
