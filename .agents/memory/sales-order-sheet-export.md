---
name: Sales-order Google Sheet export layout
description: Layout/decisions for the sync-sheet export in sales-orders.ts (one row per item, kode barang, kode customer)
---

# Sales-order Sheet export

The `POST /sales-orders/:id/sync-sheet` export writes **one row per line item**
(not one row per order). Order-level fields (Customer, No HP, Subtotal, Diskon,
PPN, Total, Status, Catatan) are intentionally **repeated on every item row** —
this was an explicit user request, so don't "normalize" it back to one row.

- **Kode Barang (column D)**: looked up live from `productsTable` (owner-scoped)
  by `productId`, falling back to the per-line snapshot `it.code`; blank for
  manual lines (`productId == null`). "Live lookup, snapshot fallback" was the
  chosen semantic so the sheet reflects current SKUs but stays populated if a
  product was later deleted.
- **Kode Customer**: a chat-level attribute (`chats.customer_code`), typed
  manually in the chat Info tab. Read **live at sheet-write time** from the
  linked chat (joined through `channels` for owner scoping), not snapshotted on
  the order — so editing it in the Info tab after the order exists still flows
  to the sheet.

**Why header migration matters:** the header is only auto-seeded when the tab is
empty. When the column layout changes, legacy tabs keep the OLD header while new
rows use the new shape → header/data drift. The fix: before appending, read row
1, and if it doesn't match the current HEADER, rewrite row 1 in place. Any future
column change to this export must keep that row-1 compare/rewrite in lockstep
(and update the `A1:P1` range if the column count changes).
