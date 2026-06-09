-- Default channel — lets each user pin one channel as the default view on app load.
-- Apply via raw psql (repo keeps no drizzle migration history):
--   psql "$DATABASE_URL" -f lib/db/migrations/0005_default_channel.sql
-- Idempotent: safe to re-run. Additive only; never drops/rewrites existing data.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

COMMIT;
