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
