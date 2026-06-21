-- WorkBoard task comments + @mentions + mention notifications.
-- Apply: psql "$DATABASE_URL" -f lib/db/migrations/workboard-comments.sql
-- Additive: does not touch existing WorkBoard tables.

-- ── Comments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workboard_task_comments (
  id                  serial PRIMARY KEY,
  task_id             integer NOT NULL REFERENCES workboard_tasks(id) ON DELETE CASCADE,
  board_id            integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  author_user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body                text NOT NULL,
  -- Denormalised cache of mentioned user ids, in order of appearance. Source of
  -- truth is workboard_comment_mentions; this is rebuilt on each write.
  mentioned_user_ids  integer[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workboard_comments_task_idx   ON workboard_task_comments (task_id);
CREATE INDEX IF NOT EXISTS workboard_comments_board_idx  ON workboard_task_comments (board_id);
CREATE INDEX IF NOT EXISTS workboard_comments_author_idx ON workboard_task_comments (author_user_id);

-- ── Mentions (join, source of truth) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workboard_comment_mentions (
  id                  serial PRIMARY KEY,
  comment_id          integer NOT NULL REFERENCES workboard_task_comments(id) ON DELETE CASCADE,
  mentioned_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workboard_comment_mentions_unique
  ON workboard_comment_mentions (comment_id, mentioned_user_id);
CREATE INDEX IF NOT EXISTS workboard_comment_mentions_user_idx
  ON workboard_comment_mentions (mentioned_user_id);

-- ── Mention notifications (in-app bell) ─────────────────────────────────────
-- One row per mention delivered to a recipient. Modeled on acr_notifications but
-- with WorkBoard-specific refs + a deep-link target (board_id + task_id).
CREATE TABLE IF NOT EXISTS workboard_notifications (
  id                  serial PRIMARY KEY,
  recipient_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Tenant scope (the owner the recipient belongs to), for scoping/cleanup.
  owner_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id            integer NOT NULL REFERENCES workboard_boards(id) ON DELETE CASCADE,
  task_id             integer NOT NULL REFERENCES workboard_tasks(id) ON DELETE CASCADE,
  comment_id          integer NOT NULL REFERENCES workboard_task_comments(id) ON DELETE CASCADE,
  type                text NOT NULL DEFAULT 'mention',
  is_read             boolean NOT NULL DEFAULT false,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workboard_notifications_recipient_idx
  ON workboard_notifications (recipient_user_id, is_read);
