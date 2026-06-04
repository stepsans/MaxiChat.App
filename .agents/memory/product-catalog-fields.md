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
in-stock-only checkbox filtering `p.stock != null && p.stock !== 0`.

## Internal-only fields must never reach customers
Internal fields: `priceSilver/Gold/Platinum/Reseller/Distributor`, `stock`, `stockOnHand`.
Only `price` (Harga Pricelist) is customer-facing.

**Why:** these are agent-facing figures; leaking stock/tier prices to customers is a
business mistake.
**How to apply:** when building any outbound message (send-product caption in
chats.ts, quotation PDF/items, AI knowledge text in products.ts `buildKnowledgeContent`),
include only name/code/public price/imageUrl. Never spread the whole product row into
a customer-facing payload.
