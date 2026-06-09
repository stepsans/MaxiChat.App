---
name: Trial onboarding & health score
description: Conventions for the trial/onboarding-checklist/health-score/drip feature surface.
---

# Trial system, onboarding checklist & customer health score

- **Admin trial routes are non-OpenAPI.** `/admin/trial-monitor` (GET) and
  `/admin/users/:id/grant-trial` (POST) are hand-written, NOT in the OpenAPI
  spec, so both admin `TrialMonitor.tsx` and whatsapp-ai `OnboardingChecklist.tsx`
  call them via raw `fetch("/api/...", { credentials: "include" })`, not codegen hooks.
  **Why:** the feature didn't add spec entries; keep it that way unless someone
  adds the contract first.

- **Tenant-owner scoping must exclude platform admins.** Any "list/act on trial
  tenants" query needs `parentUserId IS NULL AND role != 'admin'` — `parentUserId
  IS NULL` alone lets a platform `admin` account leak into the trial monitor and
  be force-granted a trial subscription. Mirrors the documented
  subscription-readonly-enforcement rule.

- **"{n}h" = hari (days), not hours.** TrialMonitor renders `trialDaysLeft` with
  an `h` suffix; in Indonesian copy `h` abbreviates *hari*. Do not "fix" it to hours.

- **refreshChecklist triggers are best-effort and the WA one lives in
  whatsapp.ts.** The real `waConnected` flip happens in the Baileys
  `connection.update` "open" handler (whatsapp.ts), not channels.ts. Product-create
  (products.ts) and agent-invite (agents.ts) triggers wrap refreshChecklist in
  try/catch so they never disturb the primary response. GET /onboarding/checklist
  also recomputes on every poll, so an immediate trigger is a latency nicety, not
  correctness-critical.

- **Health-score chat-existence check uses `inArray(channelId, ids)`**, never
  `and(...ids.map(eq))` — the latter is always false for >1 channel.

- **grant-trial is a deliberate manual admin override**, not a webhook: it sets
  `currentPeriodEnd = now + trialDays` via upsert on `subscriptions.userId`. Retries
  re-anchor the end from "now" by design; it is not meant to be retry-stable.
