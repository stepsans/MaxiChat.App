---
name: drizzle-kit push interactive prompts
description: Why `pnpm --filter @workspace/db run push` can fail with a TTY error, and the safe workaround.
---

`drizzle-kit push` runs an interactive prompt (renamed-vs-new table, drop confirmations, etc.) any time it sees DB objects the current schema doesn't define. In Replit's non-TTY shell that throws:
`Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false).`

`push-force` doesn't bypass these specific resolver prompts — it's about skipping the "are you sure" *after* the plan, not about resolving ambiguous diffs.

**Why:** the live DB in this project has tables (e.g. `credentials`, `product_sync_config`, `knowledge_sync_config`, `shortcut_sync_config`) created by earlier features whose Drizzle definitions aren't in `lib/db/src/schema/`. A blind push would propose dropping them.

**How to apply:** for additive-only schema changes (new table, new column), don't rely on drizzle push. Apply the DDL with `IF NOT EXISTS` via `executeSql` in code execution. Reserve drizzle push for a deliberate session where someone audits and re-imports the orphan tables into the schema first.
