---
name: Hybrid subscription data foundation
description: Schema + design conventions for the prepaid+add-on (Hybrid) subscription system; what's source-of-truth vs computed, money units, and how migrations are applied in this repo.
---

The Hybrid subscription system (prepaid base plan + paid add-ons/top-ups, Xendit gateway) is built on a few foundation tables and conventions. The catalog is **admin-configurable from the DB**, never hardcoded.

- **Plans/add-ons are DB catalog rows, not code.** `plans` (machine `key` UNIQUE, matching `users.plan`) and `addons` (`type` ∈ token/channel/user_seat) hold quotas + prices. Any per-plan limit (e.g. invited-seat cap) must be read from the catalog by key, with the old hardcoded map kept only as a fallback when the row is missing. Pass the **raw** `users.plan` to the lookup — never narrow it to the legacy union first, or custom/future plan keys silently collapse to "basic".

- **`tenant_quota` stores LIMITS only (plafon), never "used".** A limit = active plan quota + add-on top-ups in the period. Actual usage is computed **live** from existing tables (`ai_usage_events` via `computeBillingPeriod`, plus member/channel counts) to avoid a second source of truth that drifts. Do not denormalize a `tokenUsed`/`token_terpakai` counter.

- **Money is whole-integer Rupiah** (no cents/decimals), consistent with the existing `pricing_config`/`usage_snapshots` billing tables.

- **`payments.external_id` is the provider (Xendit) reference for idempotent webhook reconciliation** — a webhook arriving twice must find the row already `paid` and no-op. It's a nullable column with a plain UNIQUE index (Postgres allows multiple NULLs; uniqueness enforced only when present).

**Why:** the existing metered billing engine already computes usage live; reusing it keeps one source of truth. Catalog-in-DB is an explicit product requirement (admin edits plans/prices without redeploys).

**How to apply (migrations):** this repo does **not** maintain a drizzle migration history — `lib/db/drizzle/meta` only ever had `0000__tmp_diff` and never tracked the earlier billing tables. Apply new tables with raw `psql "$DATABASE_URL"` (CREATE TABLE IF NOT EXISTS, matching the Drizzle column defs exactly) the same way the rest of the schema was applied. Do NOT run `drizzle-kit push` — it needs a TTY (crashes in the agent shell) and proposes dropping unrelated tables like `user_sessions`.
