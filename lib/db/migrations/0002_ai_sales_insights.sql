-- AI Sales Assistant — detection insights + settings (Enterprise-only).
-- Apply via raw psql (repo keeps no drizzle migration history):
--   psql "$DATABASE_URL" -f lib/db/migrations/0002_ai_sales_insights.sql
-- Idempotent: safe to re-run. Additive only; never drops/rewrites existing data.

BEGIN;

-- Latest AI analysis ("AI Sales Insight") for a chat — exactly one row per chat
-- (unique chat_id), refreshed on every detection run. This is what the
-- conversation sidebar reads; it exists even when no opportunity was created
-- (auto-create OFF = recommend only). Operational data (wiped by tenant-reset).
-- All money is whole-integer Rupiah.
CREATE TABLE IF NOT EXISTS sales_insights (
  id                  serial PRIMARY KEY,
  owner_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id             integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  channel_id          integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_phone       text    NOT NULL,
  lead_score          integer NOT NULL DEFAULT 0,
  intent_category     text,
  estimated_value_idr bigint  NOT NULL DEFAULT 0,
  product_interest    jsonb   NOT NULL DEFAULT '[]'::jsonb,
  score_reason        text,
  ai_notes            text,
  recommendation      text,
  waiting_status      text,
  last_message_id     integer,
  analyzed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_insights_chat_unique
  ON sales_insights (chat_id);
CREATE INDEX IF NOT EXISTS sales_insights_owner_idx
  ON sales_insights (owner_user_id);

-- Per-tenant-owner "AI Sales Assistant" configuration — one row per owner
-- (unique owner_user_id). Powers Toggle 1 (Auto-Create Opportunity). Defaults
-- are fully INERT: auto_create_enabled = false means the AI only recommends and
-- never creates an opportunity until the owner turns it on. This is tenant
-- CONFIGURATION (like pipeline preferences), NOT operational data → it survives
-- tenant-reset.
CREATE TABLE IF NOT EXISTS sales_assistant_settings (
  id                    serial PRIMARY KEY,
  owner_user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auto_create_enabled   boolean NOT NULL DEFAULT false,
  auto_create_threshold integer NOT NULL DEFAULT 70,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_assistant_settings_owner_unique
  ON sales_assistant_settings (owner_user_id);

COMMIT;
