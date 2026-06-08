---
name: drizzle-kit push needs TTY
description: How to apply schema changes when drizzle-kit refuses to run non-interactively.
---

`drizzle-kit push` prompts interactively for "data-loss-risk" operations (adding a UNIQUE constraint to a populated table, truncations, type narrowings). In the agent shell there is no TTY, and `--force` does NOT suppress these prompts — push crashes with `Interactive prompts require a TTY terminal`.

**Why:** Drizzle treats any constraint that *could* fail at apply-time as needing human confirmation, even when the data is actually clean.

**How to apply:**
- First check whether the prompt is real: `psql ... -c "SELECT col, count(*) FROM t GROUP BY col HAVING count(*) > 1"` for unique constraints, or inspect the offending rows.
- If safe, apply the offending `ALTER TABLE` manually via `psql "$DATABASE_URL" <<SQL ... SQL`, then re-run `drizzle-kit push --force` — it will report `Changes applied` with no diff and the schema stays in sync.
- Never just delete the schema change to silence the prompt; the code will diverge from the DB.

**Post-merge silent drift → app-wide breakage:** when a task's post-merge reconciliation push fails (TTY prompt), the new column never lands in the dev DB while the merged code already references it. Because handlers use Drizzle `.select()` (= `SELECT` of every schema column), a SINGLE missing column makes EVERY query on that table throw `column "x" does not exist` → 500 → and the frontend often masks it as a generic empty/"not found" state (e.g. chat detail showed "Chat tidak ditemukan"). When a whole surface breaks right after a merge, suspect schema drift first: run the exact `SELECT *` the handler runs against a real row, then `psql -c "\d <table>"` and add the missing column(s) with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Recently seen: `chat_messages.status` (outbound blue ticks) and `users.is_infinity_owner` both missing at once.
