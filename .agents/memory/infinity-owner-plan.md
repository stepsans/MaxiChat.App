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
- Routes `/billing/me` + `/billing/quota` + `/agents` (TeamListing) add `unlimited:true` +
  synthetic plan label/key (`INFINITY_PLAN_LABEL`/`INFINITY_PLAN_KEY`). Frontend (Dashboard
  QuotaBar, Billing page, Agents/Team page) renders ∞/"Owner Infinity" + suppresses
  checkout/bill/trend/at-limit warnings when `unlimited`.

## DISPLAY surfaces must honor the flag too, not just enforcement gates
**Why:** `users.plan` for the infinity owner stays at its `"basic"` default forever (infinity
is never written to the plan column). ANY surface that renders the raw `plan` (Team/Agents
"Paket {plan}", admin tenant listings, etc.) shows "basic" while the flag is true — operators
read this as the plan "reverting to basic" and re-toggle the flag, but the display never
changes because it ignores the flag. There is NO runtime writer that flips the flag→false or
plan→"basic" (seed.ts is insert-only; dunning/monthly-close touch `subscriptions.status` only).

**How to apply:** any NEW quota/limit/billing/read-only gate must call `isInfinityOwner` and
bypass, AND any surface that DISPLAYS `users.plan` must surface `unlimited`/the synthetic
infinity label instead of the raw key. Verify scoping by confirming a non-infinity account
still returns `unlimited:false` + read-only + its real plan key.
