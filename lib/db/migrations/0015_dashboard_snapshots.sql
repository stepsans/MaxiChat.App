-- Dashboard KPI snapshot cache (spec 2.8 / 3.6). Heavy Tier-1 analytics are
-- aggregated 5×/day at the WIB cutoffs and stored here so "Hari ini" loads
-- instantly instead of scanning chat_messages/analyses on every open.
--
-- The Drizzle definition (lib/db/src/schema/dashboard-snapshots.ts) shipped
-- ahead of the migration set; this back-fills the CREATE TABLE so a fresh DB
-- deploy has the table the snapshot scheduler (lib/dashboard-snapshot.ts) needs.
-- Apply: psql "$DATABASE_URL" -f lib/db/migrations/0015_dashboard_snapshots.sql
CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id             serial PRIMARY KEY,
  owner_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_at    timestamptz NOT NULL,
  window_from    timestamptz,
  window_to      timestamptz,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_snapshots_owner_at_idx
  ON dashboard_snapshots (owner_user_id, snapshot_at);
