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
owners should filter both predicates.
