---
name: Sales-order discount math
description: How global + per-item discounts compose with PPN, and why the server clamps but must also validate.
---

Sales orders support discounts at two levels, each independently percent OR nominal Rupiah:

- **Per-item**: applied to the line gross (`qty * price`) → net line total.
- **Global**: applied to the subtotal (sum of net line totals), before PPN.
- **Order of operations**: per-item discount → subtotal → global discount → PPN on the discounted base (PPN-included and PPN-excluded paths both branch off the post-discount base).
- `discountFor(type, value, base)` = `value <= 0 ? 0 : clamp(0..base, type === 'percent' ? round(base*value/100) : value)`.

**Why:** Discounts must never make a line/total negative, and PPN must be computed on what the customer actually pays, not the pre-discount gross.

**How to apply:**
- The compute lives in BOTH `artifacts/api-server/src/routes/sales-orders.ts` (server-authoritative: `discountFor`/`computeTotals`) and a client mirror in `ChatInfoSidebar.tsx` (`discountAmountFor`/`lineNetTotal`/`computeTotals`). Any change to the formula must be made in lockstep in both, or the previewed totals drift from the persisted ones.
- The compute clamps the discount amount to the base, so totals stay bounded even with garbage input. That is NOT enough on its own: zod input validation must also reject `discountType === 'percent'` with `discountValue > 100` (both item- and order-level via `superRefine`), otherwise nonsensical percent values get persisted and shown in summaries even though the money stays correct.
