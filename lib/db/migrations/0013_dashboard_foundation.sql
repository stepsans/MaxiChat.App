-- Dashboard revisi — foundation (additive). Apply:
--   psql "$DATABASE_URL" -f lib/db/migrations/0013_dashboard_foundation.sql

-- ── System Health: scheduler heartbeat (spec 2.7 / A.9) ──────────────────────
CREATE TABLE IF NOT EXISTS job_runs (
  id             serial PRIMARY KEY,
  owner_user_id  integer,
  job_name       text NOT NULL,
  status         text NOT NULL,
  started_at     timestamptz,
  finished_at    timestamptz,
  error_message  text,
  meta           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_runs_name_created_idx ON job_runs (job_name, created_at);
CREATE INDEX IF NOT EXISTS job_runs_owner_idx        ON job_runs (owner_user_id, job_name, created_at);

-- ── Chatbot menu-press events (spec 2.1 / A.4) ───────────────────────────────
CREATE TABLE IF NOT EXISTS chatbot_flow_events (
  id              serial PRIMARY KEY,
  owner_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flow_id         integer NOT NULL REFERENCES chatbot_flows(id) ON DELETE CASCADE,
  node_id         text NOT NULL,
  option_id       text,
  node_label      text NOT NULL,
  level           integer NOT NULL DEFAULT 1,
  parent_node_id  text,
  contact_id      integer,
  channel_id      integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chatbot_flow_events_owner_created_idx ON chatbot_flow_events (owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS chatbot_flow_events_owner_node_idx    ON chatbot_flow_events (owner_user_id, flow_id, node_id);

-- ── AI Chat Report cache (spec 2.4 / A.3) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_chat_reports (
  id             serial PRIMARY KEY,
  owner_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date    date NOT NULL,
  scope          text NOT NULL DEFAULT 'daily',
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_reports_owner_date_scope_unique
  ON ai_chat_reports (owner_user_id, report_date, scope);

-- ── Agent quality scores cache (spec 2.6 / A.8) ──────────────────────────────
CREATE TABLE IF NOT EXISTS agent_quality_scores (
  id                  serial PRIMARY KEY,
  owner_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_date         date NOT NULL,
  lang_quality        integer,
  answer_accuracy     integer,
  complaint_handling  integer,
  sample_count        integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_quality_scores_owner_agent_date_unique
  ON agent_quality_scores (owner_user_id, agent_user_id, period_date);

-- ── Sentiment on analysis rows (spec 2.2) ────────────────────────────────────
ALTER TABLE ai_pipeline_analyses ADD COLUMN IF NOT EXISTS sentiment text;
