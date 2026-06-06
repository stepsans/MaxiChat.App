---
name: Subscription read-only enforcement
description: Pitfalls when enforcing expired/suspended tenants into read-only mode and scoping tenant-owner billing queries.
---

# Read-only subscription enforcement

The enforcement middleware blocks tenants in read-only (expired/suspended) state
by HTTP method (POST/PUT/PATCH/DELETE) after `requireAuth`. Two sharp edges:

## Mutating GET endpoints bypass method-based blocking
**Rule:** any GET handler that writes to the DB (e.g. the Google OAuth
`GET /credentials/oauth/callback`, which updates the credential row + can trigger
contact sync) is NOT covered by the method-based middleware. Guard those routes
explicitly with `isOwnerReadOnly(ownerId)` before the mutation.

**Why:** the middleware allow-lists all GETs for read-friendliness (a read-only
tenant must still be able to view everything). A side-effecting GET silently slips
through, letting an expired tenant mutate state — a broken-access-control hole.

**How to apply:** when adding any GET that writes, add the read-only guard inline.
The `/billing` and `/admin` path prefixes are exempt from enforcement entirely, so
never add a tenant-writable endpoint under those prefixes expecting enforcement.

## Tenant-owner queries must exclude the platform admin
**Rule:** "tenant owner" is `parent_user_id IS NULL` **AND** `role != "admin"`.
Signup creates owners with `role="user"`; the platform super-admin has
`role="admin"` and is ALSO parent-null. Revenue (MRR/ARR/ARPU/counts) and
subscription-admin (renew/suspend) owner-sets must add `ne(role,"admin")` or the
admin account inflates tenant counts and skews ARPU, and becomes renewable as a
fake tenant.

**Why:** parent-null alone is the historical owner predicate (used by usage
snapshots + billing list), but it conflates the platform admin with paying
tenants.

**How to apply:** every new billing/revenue/subscription query that enumerates
owners should filter both predicates. The admin `/billing` list itself was a
real miss here (filtered parent-null only), so its rows could surface the admin
account and its row-actions would 404 in the renew route.

## Infinite (unlimited) validity = active + null period end
**Rule:** "selamanya"/unlimited validity is modeled as stored `status="active"`
with `currentPeriodEnd=null` — there is no separate "unlimited" status. The admin
grants it via the renew action's `setUnlimited` flag, which forces active + clears
the period end and takes precedence over status/extendMonths.

**Why:** `computeEffectiveStatus` already treats a null period end on a trial/active
row as never-expiring, so no schema/enum change is needed. There is no usage quota
to lift — the billing model only meters usage, so "database/token forever" just
means the account is never flipped read-only.

**How to apply:** UI must render the period as "Selamanya" only when
`status==="active" && currentPeriodEnd==null` (a null period on a non-active row is
just "no date"). Don't try to `extendMonths` an unlimited row — clear the flag and
set a concrete status first.
