-- AI Pipeline: custom prompt + visibility per role/user
-- Apply via: psql "$DATABASE_URL" -f lib/db/migrations/0008_ai_pipeline_prompt_visibility.sql
-- Idempotent: safe to re-run.

BEGIN;

-- ============================================================
-- 1. Kolom baru di ai_pipelines
-- ============================================================
ALTER TABLE ai_pipelines
  ADD COLUMN IF NOT EXISTS custom_prompt    text,
  ADD COLUMN IF NOT EXISTS prompt_version   integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS direction_filter boolean NOT NULL DEFAULT true;

-- ============================================================
-- 2. ai_pipeline_prompt_versions — audit log setiap perubahan prompt
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_prompt_versions (
  id             serial PRIMARY KEY,
  pipeline_id    integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  owner_user_id  integer NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  version        integer NOT NULL,
  prompt_text    text    NOT NULL,
  changed_by     integer NOT NULL REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now(),
  change_note    text
);
CREATE INDEX IF NOT EXISTS ai_pipeline_prompt_versions_pipeline_idx
  ON ai_pipeline_prompt_versions (pipeline_id, version DESC);

-- ============================================================
-- 3. ai_pipeline_visibility — visibility per role per pipeline
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_visibility (
  id             serial PRIMARY KEY,
  owner_user_id  integer NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  pipeline_id    integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  role           text    NOT NULL,  -- 'supervisor' | 'agent'
  can_view       boolean NOT NULL DEFAULT false,
  can_edit       boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pipeline_visibility_unique
  ON ai_pipeline_visibility (owner_user_id, pipeline_id, role);
CREATE INDEX IF NOT EXISTS ai_pipeline_visibility_pipeline_idx
  ON ai_pipeline_visibility (pipeline_id);

-- ============================================================
-- 4. ai_pipeline_user_visibility — override per user (wins over role default)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_user_visibility (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  pipeline_id integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  can_view    boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pipeline_user_visibility_unique
  ON ai_pipeline_user_visibility (user_id, pipeline_id);

COMMIT;
