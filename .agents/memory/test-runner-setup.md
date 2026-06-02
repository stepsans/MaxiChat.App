---
name: api-server test runner
description: How unit tests run in artifacts/api-server (node:test via tsx) and the pure-helper pattern that keeps them DB-free.
---

The api-server uses the **built-in Node test runner** (`node:test` + `node:assert/strict`) executed through `tsx`, not vitest/jest. Script: `pnpm --filter @workspace/api-server run test` → `tsx --test "src/**/*.test.ts"`. Test files are `*.test.ts` colocated next to the code.

**Why:** the repo had no test infra; `tsx` was already in the workspace catalog, so node:test avoids adding a heavier framework + config.

**How to apply:** unit-tested logic must NOT import `@workspace/db` — it connects to Postgres eagerly at import time and throws if `DATABASE_URL` is unset, which would crash any test that transitively imports it. Keep pure logic in db-free modules (e.g. `lib/contact-match.ts`, `lib/group-participants.ts`) and have the db-backed module fetch rows then delegate to the pure helper. Test the pure helper directly.
