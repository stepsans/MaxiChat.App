-- AI Sales Assistant — Pipeline Health thresholds (Enterprise-only).
-- Apply via raw psql (repo keeps no drizzle migration history):
--   psql "$DATABASE_URL" -f lib/db/migrations/0003_ai_sales_pipeline_health.sql
-- Idempotent: safe to re-run. Additive only; never drops/rewrites existing data.

BEGIN;

-- Pipeline Health tuning on the per-owner AI Sales Assistant config row. An
-- open opportunity is flagged "high risk" when its estimated value is
-- >= high_value_threshold_idr AND it has had no activity for
-- >= stale_days_threshold days. high_value_threshold_idr = 0 means value never
-- excludes (only staleness matters). Both are whole-Rupiah-friendly defaults
-- and inert until the owner surfaces them in the UI.
ALTER TABLE sales_assistant_settings
  ADD COLUMN IF NOT EXISTS stale_days_threshold integer NOT NULL DEFAULT 14;

ALTER TABLE sales_assistant_settings
  ADD COLUMN IF NOT EXISTS high_value_threshold_idr bigint NOT NULL DEFAULT 0;

COMMIT;
