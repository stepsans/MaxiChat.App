---
name: Cart single-payment settlement ordering
description: How a multi-item billing cart settles as ONE payment row, and why plans must be applied before add-ons.
---

# Cart = one order = one payment row

A billing checkout cart (plan + add-ons) is persisted as a SINGLE `payments`
row with `kind="cart"` and a `line_items` jsonb snapshot
(`[{kind,refId,quantity,name,unitPriceIdr,lineAmountIdr}]`). One cart → one
Xendit invoice OR one manual Sheet row. Legacy single-kind branches
(`plan`/`addon`/`renewal`) stay in the settlement switch for old rows.

## Rule: apply plans BEFORE add-ons within the same cart settlement
**Why:** activating a plan RESETS the owner's quota to the plan's base quota
(plafon). If an add-on top-up is applied first and the plan second, the plan
activation wipes the just-granted add-on quota. Sorting plans-first guarantees
the add-on top-up lands on top of the fresh plan base.
**How to apply:** in `applyPaidPayment` "cart" branch, sort line_items so
`kind==="plan"` runs first, then loop add-ons. All inside the one settlement
transaction so the `pending→paid` flip + every grant are atomic (a failed grant
rolls back to `pending`, retriable, tenant never charged without quota).

## Cart constraints are SERVER-enforced
≤1 plan line, plan quantity forced to 1, add-on quantity integer ≥1, ≥1 item
total. Amount is computed server-side from the active catalog (never trust
client price); re-check `Number.isInteger` on refId+quantity (OpenAPI `integer`
codegens to `zod.number()` which accepts decimals). Whole-integer Rupiah.

## PDF invoice endpoint is deliberately NOT in OpenAPI
`GET /billing/payments/:id/invoice` returns a binary `application/pdf` built
with pdf-lib (not pdfkit — esbuild can't bundle pdfkit fonts). It is
owner-scoped: query by `(id, ownerUserId)`, 404 (non-enumerable) otherwise.
Frontend downloads via raw `fetch('/api/...',{credentials:'include'})`→blob,
matching the avatar-upload precedent — binary endpoints skip codegen. When
`line_items` is empty (legacy rows) the PDF synthesizes a single line.
