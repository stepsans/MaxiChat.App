---
name: Tenant "Reset Database" ordering & atomicity
description: Why the tenant-wide reset sweeps Object Storage before the DB transaction, and why all DB deletes + the audit insert must share one transaction.
---

# Tenant reset: storage-sweep-first, DB-deletes-in-one-tx

When wiping ALL of one tenant's operational data (chats, labels, analytics, AI
logs, uploaded files), two ordering rules are load-bearing:

1. **Sweep Object Storage BEFORE opening the DB transaction.** All of a tenant's
   media lives under the single prefix `tenants/<owner>/`, so one prefix sweep
   removes every blob (ledgered AND orphaned) and returns an exact count — do NOT
   loop per-ledger-row first and then sweep (the sweep would return ~0 because the
   blobs are already gone, so the audited `files` count under-reports).
   **Why:** storage is external to the DB, so it can't join the transaction. If the
   DB transaction later rolls back, blobs-first leaves orphaned *ledger rows*
   (recoverable — a retry/retention run still finds them) instead of orphaned
   *blobs* (a silent, unrecoverable storage leak). A sweep failure is best-effort
   (log + continue); retention reconciles leftover blobs later.

2. **All DB deletes + the audit insert run in ONE `db.transaction`.**
   **Why:** the reset is irreversible and admin-facing. Without a transaction, a
   late failure (including the audit insert) leaves the tenant half-wiped and the
   audit row missing or lying about deletes that actually rolled back. One tx makes
   DB state and the audit record all-or-nothing.

**How to apply:** any future "purge/reset/offboard tenant" work must keep this
shape — external-resource cleanup first (best-effort, accurate count), then a
single DB transaction for every row delete plus the audit/ledger write. Restrict
deletes to the documented operational set; never touch the account, subscription,
plan, quota, channels, settings, or products.

## AI Sales Assistant data is fully wiped on reset (stages too)

**Rule:** the tenant reset wipes ALL AI Sales Assistant tables, including
pipeline_stages — even though stages otherwise behave like config (products,
flows, settings are KEPT). The reset contract is "no AI Sales Assistant rows
survive."
**Why:** the seven default stages are idempotently re-seeded on the tenant's
next AI Sales Assistant access, so wiping them is non-destructive — unlike
products/flows/settings, which have no re-seed and so must be preserved.
**How to apply:** when first access (any `/sales/*` request) re-seeds defaults,
they become safe to wipe. Pair any such "wipe-and-reseed-on-next-access" data
with a per-process seed-cache invalidation after the reset commits, or the
in-memory "already seeded" guard suppresses the re-seed. Anything WITHOUT a
re-seed path (true config) stays on the keep-list.
