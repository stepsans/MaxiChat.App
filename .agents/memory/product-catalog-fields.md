---
name: Product catalog field conventions
description: How product category bucketing is derived and which product fields are internal-only (never sent to customers).
---

# Product catalog field conventions

## Category combo-box buckets are derived from the product CODE's first letter
The sidebar (ChatInfoSidebar Products/Order tabs) category filter does NOT use the
`category` text column. Buckets come from `code[0].toUpperCase()`:
`B → Bahan`, `M → Mesin` (DEFAULT view), `S → Sparepart`, anything else → `Lainnya`.

**Why:** the user defines categories purely by SKU code prefix; the free-text
`category` column is unreliable / used for AI knowledge grouping instead.
**How to apply:** any new product grouping UI should reuse the `productBucket(code)`
helper, not `p.category`.

## Internal-only fields must never reach customers
Internal fields: `priceSilver/Gold/Platinum/Reseller/Distributor`, `stock`, `stockOnHand`.
Only `price` (Harga Pricelist) is customer-facing.

**Why:** these are agent-facing figures; leaking stock/tier prices to customers is a
business mistake.
**How to apply:** when building any outbound message (send-product caption in
chats.ts, quotation PDF/items, AI knowledge text in products.ts `buildKnowledgeContent`),
include only name/code/public price/imageUrl. Never spread the whole product row into
a customer-facing payload.
