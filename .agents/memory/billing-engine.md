---
name: Usage-billed SaaS billing engine (Fase 1-3)
description: How MaxiChat computes/stores per-tenant usage bills; the non-obvious rules.
---

# Billing engine

Pricing is a DB singleton (`pricing_config`, one row) of 4 whole-Rupiah integer prices. Money is always integer Rupiah — no cents.

**Bill math** lives in db-free `billing-engine.ts` (`computeMonthlyBill`): ceil-bucket per resource — storage per 500MB, channels per 2, AI per 100 tokens, child users linear. Each bucket × its price, summed to total. Boundary semantics are unit-tested; keep tests in lockstep with any bucket change.

**Integer enforcement**: orval emits only `zod.number().min(0)` for OpenAPI `type: integer` (no `.int()`). So the integer rule for `PATCH /admin/pricing` is enforced *in the route handler* (`Number.isInteger` guard), not by the generated validator. If you move validation, keep this guard.

**Tenancy**: everything is owner-scoped. `/billing/me` resolves member→owner via `resolveOwnerUserId`, so team members see the owner's tenant-wide totals (the OpenAPI contract documents this — do NOT 403 members). `/admin/billing` enumerates only owners (`parent_user_id IS NULL`).

**Stale-session guard**: `resolveOwnerUserId` falls back to the raw userId for a deleted user, which would make `getOrCreateSubscription`'s FK insert throw 500. `/billing/me` does an explicit owner-EXISTS check → 404 instead.

**Snapshots**: daily scheduler upserts `usage_snapshots` keyed unique `(user_id, snapshot_date)`; per-owner try/catch isolates failures; once-per-day in-process dedup. Snapshots accrue forward only (no backfill).

**Out of scope (by request)**: status enforcement (Fase 4) and MRR/ARR dashboard (Fase 5). Subscription status is stored but not enforced.
