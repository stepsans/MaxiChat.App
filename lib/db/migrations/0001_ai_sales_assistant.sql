-- AI Sales Assistant foundation (Enterprise-only).
-- Apply via raw psql (repo keeps no drizzle migration history):
--   psql "$DATABASE_URL" -f lib/db/migrations/0001_ai_sales_assistant.sql
-- Idempotent: safe to re-run. Additive only; never drops/rewrites existing data.

BEGIN;

-- Entitlement flag on the admin-configurable plan catalog.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS has_ai_sales_assistant boolean NOT NULL DEFAULT false;

-- Enterprise plan ships with the AI Sales Assistant enabled by default. This is
-- a one-time data backfill on column introduction (the column default for every
-- other plan stays false). After this, operators control the flag via the admin
-- "Paket & Add-on" tab; this migration is NOT re-applied at runtime, so an
-- operator who later disables it on enterprise is respected.
UPDATE plans SET has_ai_sales_assistant = true WHERE key = 'enterprise';

-- A tenant's customizable sales pipeline stages (kanban columns). Wiped by
-- tenant-reset along with the rest of the AI Sales Assistant data; the seven
-- defaults re-seed on the tenant's next access.
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id            serial PRIMARY KEY,
  owner_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text    NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  is_won        boolean NOT NULL DEFAULT false,
  is_lost       boolean NOT NULL DEFAULT false,
  color         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_stages_owner_idx
  ON pipeline_stages (owner_user_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_owner_name_unique
  ON pipeline_stages (owner_user_id, name);

-- A sales opportunity (deal) attached to a chat (one per chat). Operational
-- data (wiped by tenant-reset). All money is whole-integer Rupiah.
CREATE TABLE IF NOT EXISTS opportunities (
  id                 serial PRIMARY KEY,
  owner_user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_user_id   integer REFERENCES users(id) ON DELETE SET NULL,
  chat_id            integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  channel_id         integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_phone      text    NOT NULL,
  contact_name       text,
  stage_id           integer REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  lead_score         integer NOT NULL DEFAULT 0,
  intent_category    text,
  estimated_value_idr bigint NOT NULL DEFAULT 0,
  status             text    NOT NULL DEFAULT 'open',
  waiting_status     text,
  product_interest   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ai_notes           text,
  last_activity_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_chat_unique
  ON opportunities (chat_id);
CREATE INDEX IF NOT EXISTS opportunities_owner_idx
  ON opportunities (owner_user_id);
CREATE INDEX IF NOT EXISTS opportunities_owner_stage_idx
  ON opportunities (owner_user_id, stage_id);
CREATE INDEX IF NOT EXISTS opportunities_assigned_idx
  ON opportunities (assigned_user_id);

-- Scheduled follow-up messages for an opportunity. Operational data.
CREATE TABLE IF NOT EXISTS opportunity_follow_ups (
  id                serial PRIMARY KEY,
  opportunity_id    integer NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  owner_user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence          integer NOT NULL,
  scheduled_at      timestamptz NOT NULL,
  status            text    NOT NULL DEFAULT 'pending',
  generated_message text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_follow_ups_opp_seq_unique
  ON opportunity_follow_ups (opportunity_id, sequence);
CREATE INDEX IF NOT EXISTS opportunity_follow_ups_owner_idx
  ON opportunity_follow_ups (owner_user_id);
CREATE INDEX IF NOT EXISTS opportunity_follow_ups_due_idx
  ON opportunity_follow_ups (status, scheduled_at);

-- Append-only audit trail of AI/sales activity. Operational data.
CREATE TABLE IF NOT EXISTS sales_audit_events (
  id             serial PRIMARY KEY,
  owner_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id integer REFERENCES opportunities(id) ON DELETE CASCADE,
  actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  event_type     text    NOT NULL,
  detail         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_audit_events_owner_idx
  ON sales_audit_events (owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS sales_audit_events_opp_idx
  ON sales_audit_events (opportunity_id);

COMMIT;
