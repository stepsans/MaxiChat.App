-- Append-only history of task transitions. Mirrors crm_events / sales_audit_events.
-- Records WHEN transitions happened so future KPI can compute on-time rate, cycle
-- time, throughput, and due-date change history. Never updated; only inserted.
--
-- NOTE: this codebase tracks completion via workboard_tasks.is_completed (an
-- explicit boolean toggle), NOT a finish-stage column. The task_completed /
-- task_reopened events therefore key off is_completed transitions.
CREATE TABLE IF NOT EXISTS workboard_task_events (
  id              serial PRIMARY KEY,
  board_id        integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  task_id         integer NOT NULL REFERENCES workboard_tasks(id) ON DELETE CASCADE,
  -- Who caused the event. 'user' for human action; 'system' reserved for any
  -- future automated transitions (e.g. scheduled archiving). No 'ai' actor for
  -- WorkBoard at this time, but the column allows it for consistency.
  actor           text    NOT NULL DEFAULT 'user',
  actor_user_id   integer REFERENCES users(id) ON DELETE SET NULL,
  -- Event type. See allowed values in the helper. Stored as text (not enum) to
  -- match crm_events convention and allow new types without migration.
  event_type      text    NOT NULL,
  -- Snapshot of the change. Shape depends on event_type. jsonb so future KPI can
  -- read structured fields (from/to column, old/new due date, etc.).
  payload         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes tuned for the aggregations KPI will need later:
--   per board over time, per task timeline, per actor (agent) over time.
CREATE INDEX IF NOT EXISTS workboard_task_events_board_idx
  ON workboard_task_events (board_id, created_at);
CREATE INDEX IF NOT EXISTS workboard_task_events_task_idx
  ON workboard_task_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS workboard_task_events_actor_idx
  ON workboard_task_events (actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS workboard_task_events_type_idx
  ON workboard_task_events (event_type);
