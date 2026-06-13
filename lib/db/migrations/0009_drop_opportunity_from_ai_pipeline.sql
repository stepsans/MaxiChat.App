-- Remove opportunity coupling from AI Pipeline.
-- The separate Pipeline/Opportunity menu has been removed.
-- Apply via: psql "$DATABASE_URL" -f lib/db/migrations/0009_drop_opportunity_from_ai_pipeline.sql

BEGIN;

ALTER TABLE ai_pipelines
  DROP COLUMN IF EXISTS auto_create_opportunity,
  DROP COLUMN IF EXISTS opportunity_threshold;

ALTER TABLE ai_pipeline_analyses
  DROP COLUMN IF EXISTS opportunity_id;

ALTER TABLE ai_pipeline_entries
  DROP COLUMN IF EXISTS opportunity_id;

ALTER TABLE ai_pipeline_cutoff_logs
  DROP COLUMN IF EXISTS opportunities_created;

COMMIT;
