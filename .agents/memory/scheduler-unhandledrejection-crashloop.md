---
name: Fire-and-forget scheduler ticks must catch their own errors
description: Why an unguarded setInterval(() => void asyncFn()) tick can crash-loop the whole prod deploy and block new-version promotion.
---

The api-server installs a global `process.on("unhandledRejection", ...)` in
`index.ts` that does `process.exit(1)` (intentional fail-fast, mirrors the
uncaughtException contract). Any background timer that fires an async function
fire-and-forget — `setInterval(() => void someAsyncFn(), ...)` — will turn a
rejected promise into an unhandledRejection and kill the entire process.

**Why this matters in production:** on Replit **autoscale**, the Postgres
connection drops routinely (`Connection terminated unexpectedly`) when the
instance is paused/recycled. An unguarded scheduler tick (e.g. a top-level
`db.select()` with no try/catch) then rejects → global handler exits → the
container crash-loops → the new deploy fails its `/api` healthcheck → Replit
**never promotes the new revision** → the live custom domain keeps serving the
OLD build. Symptom users report: "I published but the live site still shows old
features." (Confirmed root cause once via `processPendingCutoffs` in
`ai-pipeline-scheduler.ts`.)

**How to apply:**
- Every timer-launched async task MUST have a local catch boundary: either wrap
  its whole body in try/catch (like `ai-review` tickScheduler,
  `manual-payment-poller`, billing/monthly-close ticks already do) OR guard at
  the callsite: `() => fn().catch(err => logger.error({err}, "..."))`. Never
  leave a bare `() => void asyncFn()` for a fn that touches the DB/network.
- Do NOT relax the global unhandledRejection→exit policy to "fix" this; that
  contract is deliberate. Guard the ticks instead.
- This is a per-process-stability issue, but the deeper fix for this app is to
  run it on **Reserved VM, not autoscale** (persistent Baileys sockets,
  local-disk auth/media, in-process schedulers, stable DB connection). See
  `deploy-repl-layer-filesystem.md`.
