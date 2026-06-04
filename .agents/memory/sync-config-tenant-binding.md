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

## Flipping session-scope → owner-scope: audit EVERY handler, not just GET/PUT config

When making an integration resource (credentials, sheet-sync config) shared across a tenant under the super_admin owner, grep the WHOLE router for `req.session.userId` — not just the obvious `GET/PUT /sync-config`. Operational handlers (`POST /:id/sync-sheet`, `/sync-run`) also read the config/credential tables and are easy to miss.

**Trap:** a handler that already declares BOTH `const userId = req.session.userId!` AND `const ownerUserId = await requireOwnerUserId(...)` and uses `ownerUserId` for the primary lookup but leaves the *secondary* config/credential query on the session `userId`. Members then see the shared config via GET but fail operationally ("not configured / credential not found"). Minimal fix: alias `const userId = ownerUserId;` so the whole handler is owner-scoped.

**Safe to leave session-scoped:** handlers that only pass `userId` into `getCurrentOwnerPhone()` — it calls `resolveOwnerUserId()` internally, so a member id already resolves the owner's phone. The run-by-ownerPhone engines are owner-correct regardless.

**Server-side gating ≠ frontend hiding:** "only the parent can change" must be enforced on the server (`requireSuperAdmin` on sync-config PUT; the role matrix default for credentials → view-only). Hiding buttons in the React cards is UX only; the route is reachable directly.
