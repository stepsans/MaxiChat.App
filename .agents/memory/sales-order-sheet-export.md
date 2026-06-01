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

- **Served By (last column)**: the connected WhatsApp account's OWN profile
  name for the channel the chat is bound to — NOT the customer and NOT the
  channel `label`. Source: `channels.owner_name`, captured from
  `sock.user.name`/`verifiedName` on the Baileys `connection.open` event. Since
  that only fires on (re)connect, the export falls back to the live socket via
  `getLiveOwnerNameForChannel(channelId, userId)` for channels that haven't
  reconnected since the column was added. `owner_name` is deliberately NOT
  exposed through the channels API (`serialize()` maps fields explicitly).

**Why header migration matters:** the header is only auto-seeded when the tab is
empty. When the column layout changes, legacy tabs keep the OLD header while new
rows use the new shape → header/data drift. The fix: before appending, read row
1, and if it doesn't match the current HEADER, rewrite row 1 in place. Any future
column change to this export must keep that row-1 compare/rewrite in lockstep
(and update the header range if the column count changes). The export is
currently **18 columns (A..R)**: Tanggal, No Order, Kode Customer, Nama
Customer, No HP, Kode Barang, Nama Barang, Qty, Harga, Subtotal Item (gross =
qty*price), Diskon Item (= qty*price - lineTotal), Subtotal, Diskon
Keseluruhan, PPN, Total, Status, Catatan, Served By — so the header-migration
range is `A1:R1`.

**Re-save is idempotent (upsert by No Order):** a sales order spans multiple
rows (one per item), and "No Order" (column B) = `order.id`, which is the DB
primary key — the Sheet itself has NO primary key or uniqueness. On sync we read
column B, delete every grid row whose No Order matches, then append the fresh
block. So re-saving UPDATES in place instead of duplicating; if the user
manually deleted the rows, nothing matches and it just appends.
**Why:** old behavior was append-only → re-saving created duplicate blocks.
**How to apply:** grid indices are 0-based, header at index 0, so a `B2:B` read
maps result index i → grid index i+1; `deleteDimension` needs the tab's numeric
`sheetId` (resolve via `spreadsheets.get` fields `sheets.properties`, treat a
missing one as a hard error, never append-and-leave-duplicates); collapse
matches into contiguous `[start,end)` ranges and delete bottom-up so earlier
indices stay valid.
**Concurrency:** the delete-by-absolute-index is only safe if syncs to the same
tab are serialized — a concurrent sync shifting rows between the snapshot read
and the delete would clobber another order's rows. Hold a Postgres SESSION
advisory lock keyed on `spreadsheetId:sheetName` on a dedicated `pool.connect()`
client (`pg_advisory_lock(hashtextextended($1,0))`), unlock + release in a
`finally`. Session lock (not `_xact_`) avoids holding a transaction open across
the external Sheets HTTP calls; it still works across server instances.
