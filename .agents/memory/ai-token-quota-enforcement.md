---
name: AI token quota — anchor, hard-block, defer, notify
description: How the token plafon is windowed (locked anchor), enforced (hard-block in resolveAiClient), deferred (background jobs), and alerted (80/5/0%).
---

# Window, enforcement, defer, notify (builds on [[token-booster-quota]])

## Window source = tenant_quota, locked anniversary anchor (spec A1)
`resolveBillingWindow` (`lib/tenant-window.ts`) precedence: **anchorDate** (the
locked first-conversion date — current period computed LIVE from its
day-of-month via `computeBillingPeriod`, so upgrades/downgrades never shift it
and no roller scheduler is needed) → `periodStart/periodEnd` columns → join-date
fallback (unprovisioned only). `activatePlanForOwner` locks the anchor with
`anchorDate = COALESCE(existing, now)`; trial signup calls `provisionTrialQuota`
(entry-level grant, `planId` NULL so monthly-close never bills a trial,
anchorDate stays NULL until conversion). The OLD bug: window recomputed from
`joinDate` — never reintroduce that.

## Hard-block = single chokepoint in resolveAiClient (spec C1)
`getOwnerTokenQuota(ownerId)` in `lib/ai-quota.ts` is the ONE computation shared
by display, enforcement, and notify. `resolveAiClient` calls
`isOwnerTokenBlocked` at the TOP (after resolving owner) and throws
`TokenQuotaExceededError` — so all 8 AI paths (incl. background cron that bypass
route checks) are gated in one place. Blocks the NEXT call, never mid-call.
Infinity owners + uncapped (tokenLimit 0) never block. `isOwnerTokenBlocked`
fails OPEN (a metering glitch must not silence a paying tenant). Request routes:
a 4-arg error middleware in `app.ts` maps the error to **HTTP 402**. WA/Telegram
auto-reply: `generateAiReply` returns null on throw and the send sites already
substitute `tenant.fallbackMessage` (static, zero-token) — fallback for free.

## Defer + resume for background jobs (spec C2)
On `TokenQuotaExceededError`, background jobs must NOT mark their source item
failed — they reset it to retriable and call `recordDeferredJob` (idempotent on
owner+type+ref): cutoff log → `pending`, pipeline follow-up entry → left DUE,
acr job → `pending`. The `ai_deferred_jobs` table is the explicit state.
`startDeferredResumeScheduler` (5-min) releases an owner's rows once unblocked,
re-runs acr jobs explicitly (no acr pending-poller) and nudges the pipeline
processors (which re-validate every item — so no stale follow-up is sent).
Resumption reuses each job's normal re-validation; idempotency watermarks
prevent double-runs.

## Threshold notifications (spec E1/E2)
In-app bell (`QuotaBell.tsx` in the sidebar header) is driven live by
`notifyLevel` from `/ai-usage/me` — no notification-feed table needed. Email is
server-side: `startTokenNotifyScheduler` (15-min) sweeps capped owners;
`maybeNotifyTokenThreshold` emails (Resend, via `lib/email.ts`) only on
ESCALATION using `token_notify_state` (one row/owner: lastLevel + periodStart),
resetting each period. `notifyLevel`: warn80 = ≤20% left, crit5 = ≤5%, depleted
= 0 (warn20 reserved). All new tables migrated via raw psql (see
[[hybrid-subscription-foundation]]).
