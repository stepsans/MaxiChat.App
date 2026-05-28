---
name: Sync-config tables must pin to userId, not just ownerPhone
description: Per-ownerPhone config rows (sheet sync, etc.) leak cross-tenant when a phone is reassigned to a different user. Always include userId in the row and in every read/write filter.
---

# Per-ownerPhone sync configs need a userId column

Sync-config rows that bind a WhatsApp account (`owner_phone`) to an external resource — a Google Sheet, an API endpoint, anything user-specific — must store the **app user** who created the binding and filter every query by that user, not just by ownerPhone.

**Why:** WhatsApp pairings are not permanent. `user_whatsapp` rows can be reassigned (a number is moved to a new team / new operator). If the config row is keyed only by `owner_phone`, the new user's first GET on `/sync-config` inherits the prior tenant's spreadsheet/credential binding — both an information leak (they see another tenant's spreadsheetId/sheetName) and a potential write hazard (the scheduler keeps running with stale credentials).

**How to apply:**
- Schema: add `user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE`. Keep `owner_phone` unique (only one pairing at a time).
- Writes: include `userId` in the insert values. On `onConflictDoUpdate(target: ownerPhone)`, **also** overwrite `userId` so a re-bind by the new tenant takes ownership.
- Reads: filter by `AND user_id = currentUserId` everywhere, including delete-binding.
- Scheduler / engine: at run time, verify `link.userId === cfg.userId` (the current `user_whatsapp` link still points at the config's owner). If not, refuse to run — don't silently use someone else's credential. New tenant must reconfigure their own binding.
- Migration: add column nullable, backfill from `user_whatsapp` via owner_phone, delete orphans (configs whose phone is no longer linked), then `SET NOT NULL`.

Same risk applies to every other per-ownerPhone integration row (knowledge sync, shortcut sync, future webhook configs). Audit them all when adding this pattern.
