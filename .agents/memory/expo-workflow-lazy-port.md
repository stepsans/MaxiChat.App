---
name: Expo workflow reports FAILED but is actually running
description: The mobile (Expo/Metro) workflow's port-open check times out even on a healthy start; how to tell it apart from a real failure.
---

The `artifacts/mobile: expo` workflow frequently shows status FAILED with
`DIDNT_OPEN_A_PORT … didn't open port <N>` after `restart_workflow`, even when
nothing is wrong.

**Why:** Expo's Metro bundler binds its web port lazily (on first request /
first bundle), so the workflow's port-readiness probe times out before Metro
listens. This is not a crash.

**How to apply:** Don't treat that restart error as a build failure. Confirm
health by reading the latest `/tmp/logs/artifactsmobile_expo_*.log` — a healthy
start shows `Starting Metro Bundler`, `Metro waiting on …`, and
`Web is waiting on http://localhost:<N>` with no stack traces. Trust
`pnpm --filter @workspace/mobile run typecheck` for compile correctness; the
workflow status alone is not a reliable signal for Expo.
