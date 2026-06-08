---
name: Billing v2 invoice foundation
description: How the immutable invoices layer hooks into settlement; the single chokepoint phases B-H build on.
---

# Billing v2 — invoice foundation (FASE A)

MaxiChat is rebuilding billing in phases A–H. FASE A added immutable
`invoices` + `invoice_line_items` as the source of truth for revenue/MRR/history.

## Load-bearing decisions

- **Single settlement chokepoint.** Both Xendit and manual payments settle through
  `settlePaymentPaid` (`lib/subscription-purchase.ts`) — its `db.transaction` is the
  ONE place that flips pending→paid and grants entitlement. Any new financial side
  effect (invoice creation now; later phases) must hook INSIDE that transaction so it
  is atomic with the paid-flip. Do NOT add a second settlement path.
  **Why:** a payment must never be `paid` without its quota grant AND its invoice, or
  with an invoice but no quota — all-or-nothing prevents charged-but-empty / phantom
  revenue.

- **Prices are snapshotted, invoices are immutable.** Invoice lines come from the
  payment's stored `line_items` snapshot (or a synthesized line for legacy
  plan/addon/renewal rows), NEVER from the live catalog. A later catalog price edit
  must not rewrite history.

- **Idempotency = unique `invoices.payment_id` + `onConflictDoNothing`.** Webhook
  retries, concurrent settlement, and the boot backfill all converge to one invoice
  per payment. The backfill (`backfillInvoicesFromPayments`) is safe to re-run.

- **`source` discriminates origin:** `payment` (FASE A, from a ledger row) vs
  `monthly_close` (FASE B, period_* set, null payment_id — NULLs are distinct in
  Postgres so many coexist). `prorationFactor`/`calculationSource`/`coversFrom/To`
  on line items are reserved for FASE D proration — already in the schema.

## How to apply

- Adding recurring/proration/usage billing (B–D): write new invoice lines via the
  same `createInvoiceForPayment`-style path or a sibling that reuses the immutable
  tables; keep creation inside a transaction.
- FASE H (done) rewired `computeRevenue` to read invoices (MRR from latest
  monthly_close per owner; trend from all invoices by issued day). The metered
  usage_snapshots path stays for adminListBilling + computeOwnerTrend only.
- Migrations applied via raw `psql` (repo convention — never `drizzle-kit push`).
