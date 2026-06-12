---
name: api-server dev workflow is build-then-start (no watch)
description: Why a correct committed source can still run as old behavior until the api-server workflow is restarted.
---

The `artifacts/api-server` dev workflow runs `pnpm run build && pnpm run start`
(esbuild bundle → `node ./dist/index.mjs`). There is **no watch / hot-reload**.

**Consequence:** editing the source does NOT change the running process. The
running binary keeps executing the build that existed when the workflow last
started. A committed source fix can look correct in git while the live server
still exhibits the old (broken) behavior — confirmable by comparing the process
start time (`ps -o lstart`) against the source file mtime.

**Why this bites:** one WhatsApp connect/sync "muter muter" report was NOT a code
bug — the committed source already had the correct Baileys config
(`syncFullHistory:false` + `shouldSyncHistoryMessage:()=>true`). The live process
was a stale build that still emitted Baileys' "DISABLING ALL SYNC ... INITIAL LID
MAPPINGS ... INSTABILITY AND SESSION ERRORS" DANGER warning (which only fires
when `shouldSyncHistoryMessage` returns false for ALL history types). The fix was
simply restarting the workflow to rebuild.

**How to apply:** after editing api-server source, ALWAYS restart the
`artifacts/api-server: API Server` workflow before concluding a fix works or
"doesn't work". When a log shows behavior that contradicts the current source,
suspect a stale build first — check process start time vs file mtime.

**Related sync-promotion fact:** the channel only leaves "syncing"→"connected"
via `isLatest` on `messaging-history.set` OR the `SYNC_FALLBACK_MS` timer (kept
short — 30s — and reset per history batch, epoch-guarded, disarmed on close). If
the session drops before the fallback, it never promotes → perpetual spinner.
