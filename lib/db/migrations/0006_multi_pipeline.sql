-- Multi-pipeline & multi-opportunity CRM upgrade.
-- Apply via raw psql:
--   psql "$DATABASE_URL" -f lib/db/migrations/0006_multi_pipeline.sql
-- Idempotent: safe to re-run. Additive + migrates existing data.

BEGIN;

-- ============================================================
-- 1. pipelines table
-- ============================================================
CREATE TABLE IF NOT EXISTS pipelines (
  id             serial PRIMARY KEY,
  owner_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text    NOT NULL,
  pipeline_type  text    NOT NULL DEFAULT 'sales',
  color          text    NOT NULL DEFAULT '#6366f1',
  is_default     boolean NOT NULL DEFAULT false,
  is_archived    boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX  IF NOT EXISTS pipelines_owner_idx
  ON pipelines (owner_user_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_owner_name_unique
  ON pipelines (owner_user_id, name);

-- ============================================================
-- 2. Migrate existing pipeline_stages: add pipeline_id column
-- ============================================================
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS pipeline_id integer REFERENCES pipelines(id) ON DELETE CASCADE;

-- For every owner that already has stages but no pipeline row yet, create a
-- default "Pipeline Sales" pipeline and assign their existing stages to it.
DO $$
DECLARE
  r record;
  new_pipeline_id integer;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_user_id
    FROM pipeline_stages
    WHERE pipeline_id IS NULL
  LOOP
    -- Insert the Sales pipeline for this owner (skip if already exists).
    INSERT INTO pipelines (owner_user_id, name, pipeline_type, color, is_default, sort_order)
    VALUES (r.owner_user_id, 'Pipeline Sales', 'sales', '#22c55e', true, 0)
    ON CONFLICT (owner_user_id, name) DO NOTHING;

    SELECT id INTO new_pipeline_id
    FROM pipelines
    WHERE owner_user_id = r.owner_user_id AND name = 'Pipeline Sales';

    UPDATE pipeline_stages
    SET pipeline_id = new_pipeline_id
    WHERE owner_user_id = r.owner_user_id AND pipeline_id IS NULL;
  END LOOP;
END $$;

-- Now make pipeline_id NOT NULL (all rows are backfilled above).
ALTER TABLE pipeline_stages
  ALTER COLUMN pipeline_id SET NOT NULL;

-- Replace the per-owner name uniqueness with per-pipeline uniqueness.
DROP INDEX IF EXISTS pipeline_stages_owner_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_pipeline_name_unique
  ON pipeline_stages (pipeline_id, name);

-- Add pipeline-ordered index.
DROP INDEX IF EXISTS pipeline_stages_owner_idx;
CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline_idx
  ON pipeline_stages (pipeline_id, sort_order);
CREATE INDEX IF NOT EXISTS pipeline_stages_owner_idx
  ON pipeline_stages (owner_user_id);

-- ============================================================
-- 3. opportunity_products table
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunity_products (
  id              serial PRIMARY KEY,
  opportunity_id  integer NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  product_id      integer REFERENCES products(id) ON DELETE SET NULL,
  product_name    text    NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_products_opp_idx
  ON opportunity_products (opportunity_id);
CREATE INDEX IF NOT EXISTS opportunity_products_product_idx
  ON opportunity_products (product_id);

-- ============================================================
-- 4. Extend opportunities table
-- ============================================================
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS pipeline_id          integer REFERENCES pipelines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS intent_key           text,
  ADD COLUMN IF NOT EXISTS intent_type          text NOT NULL DEFAULT 'purchase',
  ADD COLUMN IF NOT EXISTS score_reason         text,
  ADD COLUMN IF NOT EXISTS recommendation       text,
  ADD COLUMN IF NOT EXISTS analyzed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS analyzed_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS key_quotes           jsonb NOT NULL DEFAULT '{"positive":[],"negative":[],"verbatim":[]}'::jsonb;

-- Back-fill pipeline_id on existing opportunities using the owner's default pipeline.
UPDATE opportunities o
SET pipeline_id = (
  SELECT p.id FROM pipelines p
  WHERE p.owner_user_id = o.owner_user_id AND p.is_default = true
  LIMIT 1
)
WHERE o.pipeline_id IS NULL;

-- Replace the single-opportunity-per-chat constraint with the new per-intent dedup.
DROP INDEX IF EXISTS opportunities_chat_unique;
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_chat_intent_unique
  ON opportunities (chat_id, intent_key)
  WHERE intent_key IS NOT NULL;

-- New indexes.
CREATE INDEX IF NOT EXISTS opportunities_pipeline_stage_idx
  ON opportunities (pipeline_id, stage_id);
CREATE INDEX IF NOT EXISTS opportunities_chat_idx
  ON opportunities (chat_id);

-- ============================================================
-- 5. manual_draft column on follow-ups (may be missing on older installs)
-- ============================================================
ALTER TABLE opportunity_follow_ups
  ADD COLUMN IF NOT EXISTS manual_draft boolean NOT NULL DEFAULT false;

-- ============================================================
-- 6. detected_candidates on sales_insights
--    Stores the raw per-candidate AI output so the sidebar can show
--    per-candidate "Buat" buttons even when auto-create is OFF.
-- ============================================================
ALTER TABLE sales_insights
  ADD COLUMN IF NOT EXISTS detected_candidates jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
