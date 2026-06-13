-- WorkBoard: Multi-board task management dengan invite system
-- Apply: psql "$DATABASE_URL" -f lib/db/migrations/workboard.sql

CREATE TABLE IF NOT EXISTS workboard_boards (
  id                  serial PRIMARY KEY,
  owner_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  description         text,
  default_view        text NOT NULL DEFAULT 'kanban',
  color               text NOT NULL DEFAULT '#6366f1',
  emoji               text,
  is_archived         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workboard_boards_owner_idx ON workboard_boards (owner_user_id);
CREATE INDEX IF NOT EXISTS workboard_boards_created_by_idx ON workboard_boards (created_by_user_id);

CREATE TABLE IF NOT EXISTS workboard_board_members (
  id                  serial PRIMARY KEY,
  board_id            integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  user_id             integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                text NOT NULL DEFAULT 'viewer',
  invited_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workboard_members_board_user_unique ON workboard_board_members (board_id, user_id);
CREATE INDEX IF NOT EXISTS workboard_members_board_idx ON workboard_board_members (board_id);
CREATE INDEX IF NOT EXISTS workboard_members_user_idx ON workboard_board_members (user_id);

CREATE TABLE IF NOT EXISTS workboard_columns (
  id          serial PRIMARY KEY,
  board_id    integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#94a3b8',
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workboard_columns_board_idx ON workboard_columns (board_id);

CREATE TABLE IF NOT EXISTS workboard_tasks (
  id                  serial PRIMARY KEY,
  board_id            integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  column_id           integer REFERENCES workboard_columns(id) ON DELETE SET NULL,
  title               text NOT NULL,
  description         text,
  priority            text NOT NULL DEFAULT 'medium',
  position            integer NOT NULL DEFAULT 0,
  due_date            timestamptz,
  tags                text,
  is_completed        boolean NOT NULL DEFAULT false,
  created_by_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workboard_tasks_board_idx ON workboard_tasks (board_id);
CREATE INDEX IF NOT EXISTS workboard_tasks_column_idx ON workboard_tasks (column_id);
CREATE INDEX IF NOT EXISTS workboard_tasks_created_by_idx ON workboard_tasks (created_by_user_id);

CREATE TABLE IF NOT EXISTS workboard_task_assignees (
  id          serial PRIMARY KEY,
  task_id     integer NOT NULL REFERENCES workboard_tasks(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workboard_assignees_task_user_unique ON workboard_task_assignees (task_id, user_id);
CREATE INDEX IF NOT EXISTS workboard_assignees_task_idx ON workboard_task_assignees (task_id);
CREATE INDEX IF NOT EXISTS workboard_assignees_user_idx ON workboard_task_assignees (user_id);
