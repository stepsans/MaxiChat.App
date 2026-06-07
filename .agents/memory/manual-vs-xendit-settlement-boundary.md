---
name: Manual vs Xendit settlement boundary
description: Why the Xendit webhook must scope lookups to provider='xendit', and why manual checkout must fail-fast.
---

# Manual vs Xendit settlement boundary

Both gateways share the `payments` table and BOTH use an externalId of the form
`maxichat-pay-<id>` — for Xendit it's only the invoice `external_id` echo (a
fallback lookup), for manual it's the canonical "Kode Pembayaran" the customer
cites on transfer.

**Rule:** the Xendit webhook reconciliation (`routes/webhooks-xendit.ts`) must
scope EVERY payment lookup to `provider='xendit'` — both the primary
`externalId == invoice.id` match and the `maxichat-pay-<id>` regex fallback.

**Why:** an unscoped fallback lets anyone holding the (shared, static) Xendit
callback token settle a *manual* order the operator never confirmed — i.e. grant
quota without payment. The poller (`manual-payment-poller.ts` →
`readAndSettleManualPayments`) is the ONLY path allowed to settle manual rows;
it settles by reading the operator's verification Sheet Status cell == LUNAS.

**How to apply:** any new settlement entry point that resolves a payment by
`maxichat-pay-<id>` must filter by the provider it's authoritative for.
`settlePaymentPaid` itself is provider-agnostic (shared by webhook + poller), so
the provider guard belongs at each *caller*, not inside it.

# Manual checkout fail-fast

Manual mode is "Otomatis": the Sheet row IS the settlement surface (operator
flips Status→LUNAS). So manual checkout (`routes/billing.ts`) must require BOTH
`isManualBankConfigured` AND `isVerificationConfigured` up front, and if the
Sheet row append throws it must mark the pending row `failed` + return 502 — a
best-effort/swallowed append would leave the customer paying into an order the
operator will never see (no LUNAS path).

# Whole-integer Rupiah at the checkout boundary

OpenAPI `integer` codegens to `zod.number()` (accepts decimals). The checkout
route re-checks `Number.isInteger` on `refId` + `quantity` before computing
`amountIdr = priceIdr * quantity`, or a fractional quantity yields non-integer
money. Same trap noted for the admin plans/addons CRUD guards.
