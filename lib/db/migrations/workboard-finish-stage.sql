-- Finish-stage flag on columns. A task is "done" iff it sits in a column
-- where is_finish_stage = true. isCompleted on tasks becomes derived from this.
ALTER TABLE workboard_columns
  ADD COLUMN IF NOT EXISTS is_finish_stage boolean NOT NULL DEFAULT false;

-- Mark existing "Done"-style columns as finish stage so current boards keep
-- working. Match common done-column names (case-insensitive). Owners can
-- adjust afterwards in the column settings UI.
UPDATE workboard_columns
   SET is_finish_stage = true
 WHERE lower(trim(name)) IN ('done', 'selesai', 'completed', 'complete', 'finished');

-- Backfill derived isCompleted from current column placement:
--   task is completed iff its column is a finish stage.
UPDATE workboard_tasks t
   SET is_completed = COALESCE(c.is_finish_stage, false),
       updated_at   = now()
  FROM workboard_columns c
 WHERE t.column_id = c.id;

-- Tasks with no column (column_id IS NULL) cannot be in a finish stage → false.
UPDATE workboard_tasks
   SET is_completed = false
 WHERE column_id IS NULL AND is_completed = true;

-- Table & Todo views are removed; only Kanban (and the Dashboard analytics tab)
-- remain. Redirect any board still defaulting to a deleted view so the stored
-- default_view never points at a view that no longer exists.
UPDATE workboard_boards
   SET default_view = 'kanban'
 WHERE default_view IN ('table', 'todo');
