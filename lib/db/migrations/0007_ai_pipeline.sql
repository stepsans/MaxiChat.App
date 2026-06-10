-- AI Pipeline feature: automated chat analysis & sales pipeline.
-- Apply via raw psql:
--   psql "$DATABASE_URL" -f lib/db/migrations/0007_ai_pipeline.sql
-- Idempotent: safe to re-run.

BEGIN;

-- ============================================================
-- 1. ai_pipelines — main config per tenant
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipelines (
  id                      serial PRIMARY KEY,
  owner_user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text    NOT NULL,
  description             text,
  is_active               boolean NOT NULL DEFAULT true,
  score_threshold         integer NOT NULL DEFAULT 70,
  opportunity_threshold   integer NOT NULL DEFAULT 80,
  auto_create_opportunity boolean NOT NULL DEFAULT false,
  auto_followup_enabled   boolean NOT NULL DEFAULT false,
  followup_intervals      jsonb   NOT NULL DEFAULT '["24h","48h","72h"]'::jsonb,
  cutoff_times            jsonb   NOT NULL DEFAULT '["12:00","23:59"]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX  IF NOT EXISTS ai_pipelines_owner_idx
  ON ai_pipelines (owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pipelines_owner_name_unique
  ON ai_pipelines (owner_user_id, name);

-- ============================================================
-- 2. ai_pipeline_channels — channels monitored per pipeline
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_channels (
  id          serial PRIMARY KEY,
  pipeline_id integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  channel_id  integer NOT NULL REFERENCES channels(id)    ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX  IF NOT EXISTS ai_pipeline_channels_pipeline_idx
  ON ai_pipeline_channels (pipeline_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pipeline_channels_unique
  ON ai_pipeline_channels (pipeline_id, channel_id);

-- ============================================================
-- 3. ai_pipeline_exclude_labels — contacts with these labels are skipped
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_exclude_labels (
  id          serial PRIMARY KEY,
  pipeline_id integer NOT NULL REFERENCES ai_pipelines(id)      ON DELETE CASCADE,
  label_id    integer NOT NULL REFERENCES customer_labels(id)   ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX  IF NOT EXISTS ai_pipeline_exclude_labels_pipeline_idx
  ON ai_pipeline_exclude_labels (pipeline_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pipeline_exclude_labels_unique
  ON ai_pipeline_exclude_labels (pipeline_id, label_id);

-- ============================================================
-- 4. ai_pipeline_analyses — AI result per contact per cutoff
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_analyses (
  id                  serial PRIMARY KEY,
  pipeline_id         integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  owner_user_id       integer NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  contact_phone       text    NOT NULL,
  contact_name        text,
  channel_id          integer NOT NULL REFERENCES channels(id)     ON DELETE CASCADE,
  channel_type        text,
  cutoff_datetime     timestamptz NOT NULL,
  cutoff_window_start timestamptz NOT NULL,
  cutoff_window_end   timestamptz NOT NULL,
  score               integer NOT NULL DEFAULT 0,
  previous_score      integer,
  score_breakdown     jsonb DEFAULT '{"buying_signal":0,"urgency":0,"engagement":0,"commitment":0,"product_fit":0,"barrier_adjustment":0}'::jsonb,
  status              text,
  estimated_value     bigint,
  product_interest    text,
  recommendation      text,
  score_reason        text,
  ai_notes            text,
  context_hash        text,
  entered_pipeline    boolean NOT NULL DEFAULT false,
  pipeline_entry_id   integer,
  opportunity_id      integer,
  raw_analysis        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_pipeline_analyses_pipeline_idx
  ON ai_pipeline_analyses (pipeline_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_analyses_owner_idx
  ON ai_pipeline_analyses (owner_user_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_analyses_contact_channel_idx
  ON ai_pipeline_analyses (contact_phone, channel_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_analyses_cutoff_idx
  ON ai_pipeline_analyses (pipeline_id, cutoff_datetime);

-- ============================================================
-- 5. ai_pipeline_entries — contacts that crossed the threshold
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_entries (
  id                    serial PRIMARY KEY,
  pipeline_id           integer NOT NULL REFERENCES ai_pipelines(id)          ON DELETE CASCADE,
  analysis_id           integer NOT NULL REFERENCES ai_pipeline_analyses(id)  ON DELETE CASCADE,
  owner_user_id         integer NOT NULL REFERENCES users(id)                 ON DELETE CASCADE,
  contact_phone         text    NOT NULL,
  contact_name          text,
  channel_id            integer NOT NULL REFERENCES channels(id)              ON DELETE CASCADE,
  channel_type          text,
  current_score         integer NOT NULL,
  estimated_value       bigint,
  product_interest      text,
  status                text    NOT NULL DEFAULT 'new',
  followup_count        integer NOT NULL DEFAULT 0,
  last_followup_at      timestamptz,
  next_followup_at      timestamptz,
  do_not_followup       boolean NOT NULL DEFAULT false,
  do_not_followup_reason text,
  do_not_followup_at    timestamptz,
  score_history         jsonb   NOT NULL DEFAULT '[]'::jsonb,
  opportunity_id        integer,
  entered_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_pipeline_entries_pipeline_idx
  ON ai_pipeline_entries (pipeline_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_entries_owner_idx
  ON ai_pipeline_entries (owner_user_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_entries_contact_channel_idx
  ON ai_pipeline_entries (contact_phone, channel_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_entries_status_idx
  ON ai_pipeline_entries (pipeline_id, status);
CREATE INDEX IF NOT EXISTS ai_pipeline_entries_followup_idx
  ON ai_pipeline_entries (next_followup_at, status);

-- ============================================================
-- 6. ai_pipeline_followup_logs — follow-up messages sent
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_followup_logs (
  id              serial PRIMARY KEY,
  entry_id        integer NOT NULL REFERENCES ai_pipeline_entries(id) ON DELETE CASCADE,
  pipeline_id     integer NOT NULL,
  contact_phone   text    NOT NULL,
  channel_id      integer NOT NULL,
  followup_number integer NOT NULL,
  message_sent    text    NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  was_replied     boolean NOT NULL DEFAULT false,
  replied_at      timestamptz,
  status          text    NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS ai_pipeline_followup_logs_entry_idx
  ON ai_pipeline_followup_logs (entry_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_followup_logs_pipeline_idx
  ON ai_pipeline_followup_logs (pipeline_id);

-- ============================================================
-- 7. ai_pipeline_cutoff_logs — audit trail for each cutoff run
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_pipeline_cutoff_logs (
  id                        serial PRIMARY KEY,
  pipeline_id               integer NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  owner_user_id             integer NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  scheduled_time            timestamptz NOT NULL,
  started_at                timestamptz,
  completed_at              timestamptz,
  status                    text    NOT NULL DEFAULT 'pending',
  contacts_processed        integer NOT NULL DEFAULT 0,
  contacts_entered_pipeline integer NOT NULL DEFAULT 0,
  opportunities_created     integer NOT NULL DEFAULT 0,
  retry_count               integer NOT NULL DEFAULT 0,
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_pipeline_cutoff_logs_pipeline_idx
  ON ai_pipeline_cutoff_logs (pipeline_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_cutoff_logs_status_time_idx
  ON ai_pipeline_cutoff_logs (status, scheduled_time);

COMMIT;
