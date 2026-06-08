---
name: Billing v2 monthly close (FASE B)
description: How recurring monthly_close invoices are raised — idempotency, eligibility, and the add-on reconstruction heuristic.
---

# Billing v2 — monthly close (FASE B)

A daily scheduler raises ONE `monthly_close` invoice per active tenant per
billing period, reflecting the active plan + standing add-ons. This is the
recurring-revenue record, raised independently of one-off payment invoices.

## Load-bearing decisions

- **Idempotency is structural, no tracking table.** The invoice number is
  deterministic per (owner, period) and `invoices.invoice_number` is UNIQUE, so a
  re-run inserts 0 rows (`onConflictDoNothing` on the number). The "MC" segment
  (`INV-<year>-MC-<ownerId>-<MM>`) keeps it from ever colliding with the
  payment-derived `INV-<year>-<padded id>` numbering. **Why:** no `(owner,period)`
  uniqueness existed; reusing the existing unique index avoids a migration.

- **Standing add-ons are reconstructed from the quota delta.** There is NO
  per-tenant "subscribed add-ons" table — the only durable signal is
  `tenant_quota.<limit> - plan.<quota>`. Each positive delta is priced via the
  representative active catalog add-on of that type (lowest id wins). Block count
  is `Math.floor(delta / unitAmount)` — WHOLE blocks only, never `Math.round`
  (rounding a fractional remainder UP would over-bill). A delta with no matching
  catalog add-on, or that can't yield ≥1 whole block, emits no line — we never
  invent a price. **Why/edge:** if multiple add-ons share a type with
  different `unitAmount`, the delta is priced against ONE of them, so the line is
  an approximation, not a purchase replay.

- **Eligibility = active tenant owners only.** Owner = `parent_user_id IS NULL`
  AND `role != 'admin'`; effective status must be "active" (computed live, lazily-
  missing subs default active). Infinity owners are unlimited + never billed →
  skipped. Owners with no plan (`tenant_quota.planId` null) produce no invoice.

- **Status `open`, period_* set, paymentId null.** monthly_close invoices are the
  recurring obligation; payment reconciliation stays separate (FASE A payment
  invoices). Prices are snapshotted from the current catalog at issue (immutable
  thereafter), same as FASE A.

## How to apply

- Pure builders live in db-free `lib/monthly-close-build.ts` (unit-tested);
  db orchestration + the daily scheduler live in `lib/monthly-close.ts`, wired in
  `index.ts`. The run is safe to invoke ad hoc (idempotent).
- FASE H still hasn't rewired `computeRevenue` to read invoices — monthly_close
  rows do not yet feed MRR/ARPU reporting.
