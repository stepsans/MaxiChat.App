-- AI Chat Report (ACR) — CS team performance evaluation.
-- Adapted from the ACR spec to this codebase: users/channels/chats use
-- integer ids; "contact" maps to a chats row (chat_id + name snapshot).

-- Per-message author attribution for outbound dashboard sends (additive).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sent_by_user_id INTEGER;

CREATE TABLE IF NOT EXISTS acr_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  weight_response_time      INTEGER NOT NULL DEFAULT 25,
  weight_language_quality   INTEGER NOT NULL DEFAULT 25,
  weight_answer_quality     INTEGER NOT NULL DEFAULT 25,
  weight_complaint_handling INTEGER NOT NULL DEFAULT 15,
  weight_missed_chat        INTEGER NOT NULL DEFAULT 10,

  sla_excellent_minutes  INTEGER NOT NULL DEFAULT 3,
  sla_good_minutes       INTEGER NOT NULL DEFAULT 5,
  sla_acceptable_minutes INTEGER NOT NULL DEFAULT 15,
  sla_poor_minutes       INTEGER NOT NULL DEFAULT 30,
  sla_critical_minutes   INTEGER NOT NULL DEFAULT 60,

  grade_a_threshold INTEGER NOT NULL DEFAULT 90,
  grade_b_threshold INTEGER NOT NULL DEFAULT 75,
  grade_c_threshold INTEGER NOT NULL DEFAULT 60,
  grade_d_threshold INTEGER NOT NULL DEFAULT 45,

  allowance_grade_a BIGINT NOT NULL DEFAULT 0,
  allowance_grade_b BIGINT NOT NULL DEFAULT 0,
  allowance_grade_c BIGINT NOT NULL DEFAULT 0,
  allowance_grade_d BIGINT NOT NULL DEFAULT 0,
  allowance_grade_e BIGINT NOT NULL DEFAULT 0,

  complaint_handling_enabled BOOLEAN NOT NULL DEFAULT true,

  auto_schedule_enabled         BOOLEAN   NOT NULL DEFAULT false,
  auto_schedule_frequency       TEXT      NOT NULL DEFAULT 'monthly',
  auto_schedule_day_of_month    INTEGER   DEFAULT 1,
  auto_schedule_day_of_week     INTEGER   DEFAULT 1,
  auto_schedule_every_days      INTEGER   DEFAULT 30,
  auto_schedule_notify_user_ids INTEGER[] NOT NULL DEFAULT '{}',
  auto_schedule_next_run_at     TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS acr_configs_owner_unique ON acr_configs(owner_user_id);

CREATE TABLE IF NOT EXISTS acr_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,

  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_auto_scheduled    BOOLEAN NOT NULL DEFAULT false,
  agent_user_ids       INTEGER[],

  status TEXT NOT NULL DEFAULT 'pending',

  progress_total     INTEGER NOT NULL DEFAULT 0,
  progress_completed INTEGER NOT NULL DEFAULT 0,

  total_agents_evaluated       INTEGER NOT NULL DEFAULT 0,
  total_conversations_analyzed INTEGER NOT NULL DEFAULT 0,
  total_messages_analyzed      INTEGER NOT NULL DEFAULT 0,

  config_snapshot JSONB NOT NULL,

  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS acr_jobs_owner_idx ON acr_jobs(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS acr_jobs_status_idx ON acr_jobs(status);

CREATE TABLE IF NOT EXISTS acr_agent_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID    NOT NULL REFERENCES acr_jobs(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL,

  agent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name    TEXT,
  agent_email   TEXT,
  agent_role    TEXT NOT NULL,

  total_score NUMERIC(5,2) NOT NULL DEFAULT 0,

  score_response_time      NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_language_quality   NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_answer_quality     NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_complaint_handling NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_missed_chat        NUMERIC(5,2) NOT NULL DEFAULT 0,

  avg_response_time_minutes NUMERIC(8,2),
  total_conversations       INTEGER NOT NULL DEFAULT 0,
  total_messages_sent       INTEGER NOT NULL DEFAULT 0,
  total_missed_chats        INTEGER NOT NULL DEFAULT 0,
  total_complaints          INTEGER NOT NULL DEFAULT 0,
  complaints_resolved       INTEGER NOT NULL DEFAULT 0,
  insufficient_data         BOOLEAN NOT NULL DEFAULT false,

  grade            TEXT   NOT NULL DEFAULT 'E',
  allowance_amount BIGINT NOT NULL DEFAULT 0,

  ai_summary      TEXT,
  ai_strengths    TEXT,
  ai_improvements TEXT,

  coaching_insights JSONB,

  red_flag_count         INTEGER NOT NULL DEFAULT 0,
  has_critical_violation BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS acr_agent_scores_job_idx ON acr_agent_scores(job_id);
CREATE INDEX IF NOT EXISTS acr_agent_scores_agent_idx ON acr_agent_scores(agent_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS acr_agent_scores_job_agent_unique ON acr_agent_scores(job_id, agent_user_id);

CREATE TABLE IF NOT EXISTS acr_red_flags (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID    NOT NULL REFERENCES acr_jobs(id) ON DELETE CASCADE,
  agent_score_id UUID    NOT NULL REFERENCES acr_agent_scores(id) ON DELETE CASCADE,
  owner_user_id  INTEGER NOT NULL,

  agent_user_id INTEGER NOT NULL,
  agent_name    TEXT,

  chat_id      INTEGER,
  contact_name TEXT,
  channel_id   INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  channel_type TEXT,

  conversation_excerpt TEXT,

  violation_type     TEXT NOT NULL,
  violation_severity TEXT NOT NULL DEFAULT 'high',

  ai_explanation    TEXT NOT NULL,
  ai_recommendation TEXT,

  score_impact_dimension TEXT,
  score_impact_points    NUMERIC(5,2),

  occurred_at       TIMESTAMPTZ,
  message_timestamp TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS acr_red_flags_job_idx ON acr_red_flags(job_id);
CREATE INDEX IF NOT EXISTS acr_red_flags_agent_score_idx ON acr_red_flags(agent_score_id);

CREATE TABLE IF NOT EXISTS acr_conversation_scores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID    NOT NULL REFERENCES acr_jobs(id) ON DELETE CASCADE,
  agent_score_id UUID    NOT NULL REFERENCES acr_agent_scores(id) ON DELETE CASCADE,
  owner_user_id  INTEGER NOT NULL,

  agent_user_id INTEGER NOT NULL,
  chat_id       INTEGER,
  contact_name  TEXT,
  channel_id    INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  channel_type  TEXT,

  first_message_at  TIMESTAMPTZ,
  last_message_at   TIMESTAMPTZ,
  total_messages    INTEGER NOT NULL DEFAULT 0,
  agent_messages    INTEGER NOT NULL DEFAULT 0,
  customer_messages INTEGER NOT NULL DEFAULT 0,

  avg_response_time_minutes   NUMERIC(8,2),
  first_response_time_minutes NUMERIC(8,2),
  max_response_time_minutes   NUMERIC(8,2),
  has_missed_message  BOOLEAN NOT NULL DEFAULT false,
  has_complaint       BOOLEAN NOT NULL DEFAULT false,
  complaint_resolved  BOOLEAN NOT NULL DEFAULT false,

  conv_score_response_time      NUMERIC(5,2),
  conv_score_language_quality   NUMERIC(5,2),
  conv_score_answer_quality     NUMERIC(5,2),
  conv_score_complaint_handling NUMERIC(5,2),
  conv_score_missed_chat        NUMERIC(5,2),
  conv_total_score              NUMERIC(5,2),

  has_red_flag    BOOLEAN DEFAULT false NOT NULL,
  red_flag_types  TEXT[],

  ai_notes TEXT,
  answer_caused_customer_silent BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS acr_conversation_scores_job_idx ON acr_conversation_scores(job_id);
CREATE INDEX IF NOT EXISTS acr_conversation_scores_agent_score_idx ON acr_conversation_scores(agent_score_id);
CREATE INDEX IF NOT EXISTS acr_conversation_scores_agent_idx ON acr_conversation_scores(job_id, agent_user_id);

CREATE TABLE IF NOT EXISTS acr_notifications (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     INTEGER NOT NULL,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  red_flag_id       UUID    REFERENCES acr_red_flags(id) ON DELETE CASCADE,
  job_id            UUID    REFERENCES acr_jobs(id) ON DELETE CASCADE,
  is_read           BOOLEAN NOT NULL DEFAULT false,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS acr_notifications_recipient_idx ON acr_notifications(recipient_user_id, is_read);
