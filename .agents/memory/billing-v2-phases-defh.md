---
name: Billing v2 phases D–H (overage/dunning/wallet/proration/retention/finops)
description: Durable design rules for the later MaxiChat Billing v2 phases — additive defaults, wallet-first checkout, and the deliberate computeRevenue/finops split.
---

# Billing v2 — later phases (overage, dunning, wallet, proration, retention, finops)

All of these are **additive + default-disabled** so they never change behavior until an operator opts in. Singleton config rows (`overage_rates`, `dunning_settings`) and the wallet/dunning tables are applied via raw `psql`, never drizzle push. Pure decision logic lives in db-free `*-build.ts` modules with node:test; DB I/O lives in sibling non-`-build` modules.

## Wallet-first checkout (load-bearing)
- The checkout wallet fast path settles ONLY when the live balance FULLY covers the cart — we never mix partial wallet credit + gateway in one order.
- **Why:** a partial split would mean two settlement sources for one `payments` row, breaking the "one order = one payment = one invoice" idempotency contract.
- **How to apply:** on any concurrent-debit / balance-shift error, fall THROUGH to the manual/xendit branch rather than failing checkout. The wallet path still routes through the single `settlePaymentPaid` chokepoint (insert paid cart payment provider="wallet" → debit → applyPaidPayment → createInvoiceForPayment, one tx).

## Proration
- Upgrade → prorated CHARGE via settlePaymentPaid (paid like any cart); downgrade → prorated CREDIT to the wallet, applied immediately. `ProrationResult.mode` = charge|credit|applied.
- **Why:** charges must go through the gateway chokepoint (real money in); credits are internal ledger movements (no gateway), so they apply instantly.

## computeRevenue vs computeFinops (deliberate drift)
- FASE H did NOT destructively rewire the legacy `computeRevenue`. `computeFinops` (`lib/finops.ts`, invoice-grounded, served at `/admin/finops`) is a SEPARATE surface.
- **Why:** rewiring the existing admin revenue dashboard risked breaking a working feature; the prime constraint is "never break existing." The "rewire to invoices" requirement is satisfied additively by the new invoice-grounded finops surface.
- **How to apply:** treat invoice-grounded metrics (MRR/ARR/ARPU/recognizedRevenue/churn) as living in finops; leave computeRevenue alone unless a future task explicitly asks to retire it.

## Retention purge
- Cutoff = `min(tenant setting, plan cap)`; purge is dry-run-capable, blob-first, and must NEVER touch financial rows (invoices/payments/wallet) — only operational data (chats/media).

## Admin vs tenant surfaces
- Config endpoints (`/admin/overage-rates`, `/admin/dunning-settings`, `/admin/finops`) are PLATFORM admin (`requireAdmin`), distinct from tenant `super_admin`. Admin UI sections live in `PaymentGateway.tsx` mirroring the StorageEnforcementSection/TaxConfigSection pattern.
- Tenant UI: `WalletCard` (balance + ledger) in `Billing.tsx`; a **Bayar** button on OPEN invoices in `InvoiceHistory.tsx` via `usePayMyInvoice`, branching on result mode (xendit redirect / manual transfer dialog / wallet instant-settle).

## Money-safety guards (added after review)
- **Downgrade credit must be atomic**: in `/billing/change-plan`, the plan swap (`applyPlanProration`) and the prorated wallet credit (`recordWalletTransaction`) MUST run in ONE `db.transaction`. **Why:** a failed credit insert after the swap silently downgrades the tenant without ever crediting the prorated difference (financial loss). Both helpers accept a trailing `exec`/`tx` param.
- **Wallet settlement helpers assert ownership**: `settleInvoiceByWallet` re-checks `invoice.userId === ownerId` inside the tx (throwing rolls back the paid-flip) even though the route already owner-scopes via `getInvoiceForOwner`. Defense-in-depth against helper reuse/miscall.
- **Known limitation (not a regression)**: pay-invoice / cart checkout create a NEW pending payment per click (no one-active-checkout-per-invoice guard) — mirrors the pre-existing cart `/checkout` pattern. Settlement is invoice-level idempotent (`markInvoicePaid` status guard prevents double entitlement grant), but a user who actually pays two gateway invoices for the same invoice can be double-collected. A dedupe guard is a future hardening, deliberately left to preserve existing behavior.
