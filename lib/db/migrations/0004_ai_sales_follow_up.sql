-- AI Sales Assistant — Auto Follow-Up engine config (Enterprise-only).
-- Apply via raw psql (repo keeps no drizzle migration history):
--   psql "$DATABASE_URL" -f lib/db/migrations/0004_ai_sales_follow_up.sql
-- Idempotent: safe to re-run. Additive only; never drops/rewrites existing data.

BEGIN;

-- Auto Follow-Up controls on the per-owner AI Sales Assistant config row. Both
-- columns are INERT by default: auto_follow_up_enabled = false means the engine
-- only RECOMMENDS follow-ups and never sends until the owner turns it on.
-- follow_up_interval_hours is the silence window (since the Last Meaningful
-- Interaction) before the next of the max-3 follow-up touches is due.
ALTER TABLE sales_assistant_settings
  ADD COLUMN IF NOT EXISTS auto_follow_up_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE sales_assistant_settings
  ADD COLUMN IF NOT EXISTS follow_up_interval_hours integer NOT NULL DEFAULT 48;

COMMIT;
