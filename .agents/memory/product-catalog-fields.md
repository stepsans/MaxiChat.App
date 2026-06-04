---
name: Product catalog field conventions
description: How product category bucketing is derived and which product fields are internal-only (never sent to customers).
---

# Product catalog field conventions

## Category combo-box options come from the `category` text column (sheet "kategori")
Both the Products page filter AND the chat right-sidebar product picker
(ChatInfoSidebar Products/Order tabs) derive their category options from distinct
trimmed `p.category` values (sorted id-ID, case-insensitive), with `__all__` =
"Semua kategori" (default) and `__none__` = "Tanpa kategori". The old code-first-letter
bucket scheme (`B/M/S/O` via `productBucket(code)`) was REMOVED from the sidebar.

**Why:** the user wants the picker categories to match the Google Sheet `kategori`
column they actually maintain, not an inferred SKU-prefix bucket.
**How to apply:** reuse the distinct-`p.category` derivation (mirror pages/Products.tsx);
do NOT reintroduce a code-prefix bucket helper. The sidebar picker also has an
in-stock-only checkbox: "jumlah > 0" means `(p.stock ?? 0) > 0 || (p.stockOnHand ?? 0) > 0`.

**Stock gotcha:** real catalogs often leave the `stock` column EMPTY (null for all
rows) and put the real quantity in `stockOnHand` (sheet "qty on hand"/"stok ready"/
"soh"). Any "in stock" filter MUST consider stockOnHand, not just stock, or it hides
everything.

## Catalog import is an upsert by (user_id, code), NOT wipe-and-replace
The import/sync endpoint upserts via `onConflictDoUpdate` on the
`products_user_code_unique` (userId, code) index, then prunes codes absent from the
file with `notInArray`. It must NOT do `DELETE all → INSERT all`.

**Why:** `products.id` is a Postgres `serial`. A full delete+reinsert of ~568 rows
drew ~568 fresh sequence values every import, so ids climbed into the tens of
thousands even though only 568 rows ever exist — the user noticed and asked why.
Upsert keeps existing ids stable.
**How to apply:** keep the `entries.length===0` guard before the prune (so the
notInArray code list is never empty → never a mass-delete). Any new bulk catalog
writer must follow the same upsert+prune shape, never wipe-and-replace.

## Internal-only fields must never reach customers
Internal fields: `priceSilver/Gold/Platinum/Reseller/Distributor`, `stock`, `stockOnHand`.
Only `price` (Harga Pricelist) is customer-facing.

**Why:** these are agent-facing figures; leaking stock/tier prices to customers is a
business mistake.
**How to apply:** when building any outbound message (send-product caption in
chats.ts, quotation PDF/items, AI knowledge text in products.ts `buildKnowledgeContent`),
include only name/code/public price/imageUrl. Never spread the whole product row into
a customer-facing payload.
