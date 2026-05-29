---
name: Server-side PDF generation
description: Why pdf-lib (not pdfkit) for PDFs in api-server, and how product images must be normalized before embedding.
---

# Server-side PDF generation (api-server)

Use **pdf-lib** for generating PDFs in `artifacts/api-server`, NOT pdfkit.

**Why:** api-server bundles to a single ESM file via esbuild (`build.mjs`). pdfkit loads its
standard-font `.afm` data files from disk at runtime relative to its package dir; esbuild does
not bundle those assets, so pdfkit throws at runtime in the built output. pdf-lib is pure JS and
embeds its StandardFonts without filesystem access, so it bundles cleanly. (Verified: server boots
and `%PDF-` output produced.)

**How to apply:**
- pdf-lib only embeds JPEG/PNG. Product/flow images can be webp/gif/etc., so run every image
  through `sharp(...).png()` (sharp is already a dep and is externalized in `build.mjs`) before
  `embedPng`. Wrap per-image load+convert in try/catch and fall back to a placeholder box so one
  bad image never fails the whole document.
- Reuse the **exported** `loadImageBuffer` from `routes/whatsapp.ts` for fetching image bytes — it
  handles `/api/media/<file>` (local disk) and SSRF-hardened http(s) fetch. Mirror the frontend's
  Google-Drive→thumbnail URL resolution server-side first (Drive "view" URLs don't return image
  content-type).
- pdf-lib has no auto text-flow/pagination — wrap text by measuring `font.widthOfTextAtSize` and
  add pages manually when the cursor passes the bottom margin.
- Bound concurrency when preloading many thumbnails (selection cap is high); fan-out of hundreds of
  simultaneous external fetches + sharp jobs is an availability risk.
