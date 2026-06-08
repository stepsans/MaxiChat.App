---
name: Billing tax/PPN (FASE G)
description: How the additive, default-disabled PPN/tax feature keeps paid invoices immutable and zero-behavior when off.
---

# Tax / PPN (FASE G)

Additive tax layer over the invoice system. **Default-disabled = exact zero behavior change.**

## Core rules
- Config lives in a singleton `tax_settings` row (id=1 CHECK). `getTaxConfig()` NEVER throws — it falls back to `TAX_DISABLED` (a disabled, rate-0 config), so a missing/broken row degrades to "no tax", never an error in the settlement path.
- Pure math is `computeInvoiceTotals(lines, taxConfig)` in `invoice-build.ts`:
  - disabled / rate 0 / zero gross → `tax 0`, `total == subtotal`.
  - **inclusive**: `net = round(gross * 10000 / (10000 + rateBps))`, `total UNCHANGED`. Tax is carved OUT of the price.
  - **exclusive**: tax `round(gross * rateBps / 10000)` added ON TOP.
  - Whole-integer Rupiah only; `rateBps` = basis points (1100 = 11%).

## The load-bearing invariant
- **Payment-sourced invoices are ALWAYS forced `inclusive: true`** (`createInvoiceForPayment`), so the invoice total can never diverge from the amount actually collected (`payment.amountIdr`). A tax misconfiguration cannot make a paid invoice charge more/less than what the gateway took.
- **Monthly-close invoices honor the config as-is** (inclusive OR exclusive) — they are billed forward, not reconciling an already-collected amount.

## Immutability (why the PDF reads the snapshot)
**Why:** invoices are immutable financial records. The PDF endpoint originally recomputed tax from the LIVE config — editing the rate (or disabling tax) would silently rewrite historical PDFs and diverge from the stored invoice (audit/legal break).
**How to apply:** `GET /billing/payments/:id/invoice` reads the frozen `invoices.subtotal_idr/tax_idr` via `getInvoiceByPaymentId(owner, paymentId)`. Only PENDING rows (no invoice yet, e.g. an unpaid manual transfer) fall back to a live inclusive preview. Any new place that renders/exports an invoice must read the snapshot, never recompute from current config. (The tax LABEL is cosmetic and not snapshotted — using the live label is fine; only the amounts must come from the snapshot.)

## Admin surface
- `/admin/tax-config` GET/PUT under `requireAdmin` (PLATFORM admin, not tenant super_admin). Route re-checks `Number.isInteger(rateBps)` + bounds 0..10000 because OpenAPI `integer` codegens to `zod.number()` (accepts decimals). `updateTaxConfig` is an atomic ON CONFLICT(id) upsert with partial-field semantics. Migration applied via raw psql (no drizzle push).
