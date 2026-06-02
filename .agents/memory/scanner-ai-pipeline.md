---
name: Scanner AI document pipeline
description: Why the receipt deskew/enhance pipeline is pure-JS, and the invariants that keep it from corrupting archived photos.
---

# Scanner AI document pipeline

The AI Review "Scanner AI" toggle deskews + enhances receipt photos before Drive
archive. The whole image pipeline is **pure JS** (homography warp on raw RGB
buffers) + `sharp` for decode/enhance/encode.

**Why pure-JS, not OpenCV-WASM:** the api-server bundles to a single CJS file via
esbuild. WASM/native image libs don't bundle cleanly there. `sharp` is already a
dep and handles decode/encode; the perspective warp is hand-rolled (8x8 DLT
homography via Gaussian elimination + inverse-map bilinear sampling). Don't
reach for an OpenCV port to "improve" it — it will break the bundle.

**Invariants that must hold (they protect the user's archived photos):**
- `scanDocument` must NEVER throw. Every failure path (model error, decode
  error, no document detected, degenerate quad, unstable homography) falls back
  to a lightly-enhanced *original* so the upload always gets a usable image.
- Detected quads are validated before warping (distinct corners + shoelace area
  >= ~10% of the image). The sum/diff corner-ordering trick silently
  mis-assigns on ties / near-collinear sets; without the area+distinctness gate
  it would warp to garbage instead of falling back.

**Usage accounting:** the corner-detection vision call records AI usage via the
same `recordAiUsage({ownerUserId, channelId, provider, model, usage})` path as
OCR, in the Drive upload loop. `recordAiUsage` no-ops on null usage, so fallback
runs don't inflate counts.

**Scope:** scanning runs ONLY in the Drive upload loop (after Sheet append), so
OCR→Sheet behavior is identical whether the toggle is on or off.
