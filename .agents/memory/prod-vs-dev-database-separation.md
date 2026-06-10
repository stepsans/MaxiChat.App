---
name: prod vs dev database separation
description: Why published app data differs from preview, and the only supported way to change production owner/seed credentials.
---

# Production DB is separate from development DB

Preview/dev and the published (autoscale) app use **two different PostgreSQL databases**. Data created or changed in one does NOT appear in the other (confirmed: owner row had different `is_infinity_owner` and password between the two).

**Why this matters:** agent `psql "$DATABASE_URL"` and dev-side writes only touch the **development** DB. The agent's `executeSql({ environment: "production" })` is **read-only** (a replica) — there is no agent write path to production data.

**How to apply — changing production owner/seed credentials (e.g. owner login on the published app):**
- Do it through code that runs at production boot: the `runSeed()` flow.
- Gate destructive overwrites behind an explicit env flag (e.g. `RESEED_OWNER_PASSWORD=1`) so the default bootstrap-only "never overwrite existing user" invariant still holds.
- The flag must be in **shared** (or production) env so it reaches the deployment, then the user must **Publish** for it to run against prod.
- It is a break-glass switch: leaving it on re-forces the credential on every boot (blocks durable rotation, re-activates the account). Remove it right after verifying the published login.

Production **schema** changes are a different mechanism (handled by Replit's Publish diff) — never write migration scripts for prod.
