-- WorkBoard-from-chat: jejak asal task.
-- source_type membedakan task biasa vs task yang lahir dari chat (dan sumber
-- lain di masa depan). Default 'manual' → semua task lama otomatis valid.
ALTER TABLE workboard_tasks
  ADD COLUMN IF NOT EXISTS source_type         text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_chat_id      integer REFERENCES chats(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_contact_name text,
  ADD COLUMN IF NOT EXISTS source_last_message text;

-- Index untuk query riwayat "task dari chat ini" (sering dipanggil dari sidebar).
CREATE INDEX IF NOT EXISTS workboard_tasks_source_chat_idx
  ON workboard_tasks (source_chat_id);
