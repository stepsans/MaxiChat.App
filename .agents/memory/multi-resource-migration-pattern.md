---
name: Multi-resource DB migration — transition with nullable foreign keys
description: When refactoring a tenancy key (e.g. owner_phone → channel_id, or single → multi parent), keep both columns nullable side-by-side instead of cut-over in one step. Leaves the app working between phases.
---

# Transition migrations: nullable new column, old column stays, swap later

When changing the tenancy / parent key of a heavily-queried table (e.g. moving from `owner_phone` to `channel_id`, or from a single-row link to a multi-row table), do **not** drop the old column and `SET NOT NULL` on the new one in the same step. Phase it.

**Phase A — Migration (single transaction, safe to run while app is live):**
- `ADD COLUMN new_id INTEGER REFERENCES …` (NULLABLE).
- `UPDATE t SET new_id = parent.id FROM parent WHERE parent.old_key = t.old_key AND t.new_id IS NULL`.
- Add indexes (incl. future unique indexes parallel to the old ones).
- **Do NOT** `SET NOT NULL` yet. **Do NOT** drop the old column yet.

**Phase B — Drizzle mirror (same commit as A):**
- Add the new column to the Drizzle schema, **NULLABLE** (no `.notNull()`). This lets existing route code that doesn't yet set the new column keep inserting without breaking typecheck. Annotate the column with a TODO comment naming the task that will make it NOT NULL.

**Phase C — Route refactor (separate commit):**
- Update every insert site to populate the new column. Update read sites to filter by the new column.
- Add a small adapter helper (e.g. `resolveChannelIdFromOwnerPhone`) for inserts that still only know the old key.

**Phase D — Tighten (later commit, after Phase C is verified in production):**
- `SET NOT NULL` on the new column. Make the Drizzle column `.notNull()`.
- Drop the old column. Drop the old indexes.

**Why this phasing matters:**
- A single-commit cut-over forces every route, every test, every migration-time insert to be perfect before the migration can land — one missed insert site fails the whole deploy.
- Phased transition means the app keeps working after Phase A+B with zero route changes. Phase C can be done file-by-file with the app live. Phase D is a tiny cleanup once Phase C is proven.
- Failed deploys roll back without data loss because the old column is still authoritative.

**How to apply:**
- Drizzle column for the new key during Phase B looks like `channelId: integer("channel_id")` — no `.notNull()`, no `.references()` chain if the FK is already created in SQL (Drizzle doesn't need the chain to type-check; the SQL FK enforces integrity).
- Always include the `WHERE t.new_id IS NULL` guard in the backfill UPDATE so the migration is idempotent.
- Verify with `SELECT count(*), count(new_id) FROM t` per table — they should be equal after backfill.
- For opt-in scoping resources (shared-with-override), prefer a join table (`product_channels`) where **empty join = available to all**, **non-empty = restricted to listed**. Avoids a nullable `restricted_to` column with confusing semantics.

**Status-mirror columns: never optimistically default to the live state.**
- When the new column carries runtime status (e.g. `channels.status: 'connected'|'disconnected'`) and is being backfilled from a legacy binding, default to the **safe/false** value — even if the legacy row "should" be live.
- Let the real subsystem (Baileys reconnect loop, websocket handler, …) flip it to `connected` only when the underlying socket is actually up.
- **Why:** if you default to `'connected'` because `legacy.owner_phone IS NOT NULL`, the UI will paint a green dot during the boot window before any socket has actually reconnected. Worse, if reconnect fails permanently, the row stays falsely green forever.
- **How to apply:** in the `ensureXForY()` helper, hardcode the conservative status. In the runtime subsystem, mirror status via a fire-and-forget `syncXStatus()` that runs on every `connection === 'open'` / `'close'` event.
- **Race caveat:** fire-and-forget UPDATEs on rapid flap can land out of order. T005-style fix: add `updated_at` and guard with `WHERE updated_at < now()`, OR sequence per-resource via an in-process mutex map.
