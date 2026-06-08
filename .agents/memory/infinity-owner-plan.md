---
name: Owner Infinity Plan
description: How the single unlimited/never-billed owner override is modeled and wired.
---

# Owner Infinity Plan

A single account gets unlimited everything (users/channels/AI tokens/db/storage),
never read-only, never billed. Modeled as an RBAC flag, NOT a catalog plan row.

## Shape
- `users.is_infinity_owner boolean NOT NULL DEFAULT false` (schema in `lib/db/.../schema/auth.ts`).
  Applied to the live DB via raw psql (repo does NOT use drizzle-kit push) AND set in
  `seed.ts` SEED_USERS so a fresh re-seed re-grants it. Only ever true for one account.
- ONE resolver chokepoint: `infinity-owner.ts` → `isInfinityOwner(ownerId)` (TTL-cached).
  Everything funnels through it; never read the column directly elsewhere.

## Why a flag, not a plan key
**Why:** the account is `role=admin` (platform admin) AND a tenant. A catalog plan would
have to be referenced by `users.plan` key and would leak into the admin-managed catalog /
other tenants. A boolean RBAC flag keeps the override scoped to exactly one user with no
catalog surface.

## Where the bypass lives (single chokepoints, don't scatter)
- `billing.ts getEffectiveSubscription` → returns `{effectiveStatus:"active", readOnly:false}`
  for infinity owners. This one function backs isOwnerReadOnly, enforce-subscription
  middleware, the AI gate, and `/billing/me` — so the bypass covers all of them at once.
- `retention.ts getPlanRetentionCap` → null (no cap).
- `agents.ts` → skips the per-plan invited-seat cap.
- Routes `/billing/me` + `/billing/quota` add `unlimited:true` + synthetic plan label/key
  (`INFINITY_PLAN_LABEL`/`INFINITY_PLAN_KEY`). Frontend (Dashboard QuotaBar, Billing page)
  renders ∞ + suppresses checkout/bill/trend when `unlimited`.

**How to apply:** any NEW quota/limit/billing/read-only gate must call `isInfinityOwner`
and bypass for it, or the infinity owner will hit the new limit. Verify scoping by
confirming a non-infinity account still returns `unlimited:false` + read-only.
