---
name: AI Review run-window watermark
description: How the daily receipt-recap run window and scheduler dedup must work to avoid dropped/duplicated receipts.
---

# AI Review (receipt recap) run-window & scheduler

The recap collects group image messages in a time window, OCRs them, and appends
one Sheet row each. The window and the scheduler dedup are coupled — get either
wrong and you silently drop or duplicate receipts.

## Rules

- **Window = since last successful run, not "local midnight → now".**
  windowStart = `cfg.lastRunAt ?? localDayStartUtc(now, tz)`; windowEnd = `now`.
  **Why:** a fixed midnight→cutoff window drops every receipt posted *after* the
  cut-off (store still open), forever. A since-last-run window rolls the full
  24h cycle into the next day's run.
- **Use `gt` (not `gte`) on windowStart**, and pass the SAME `now` into the run
  that you persist as `lastRunAt`. **Why:** windowEnd is inclusive (`lte now`),
  so the boundary message is processed this run; `gt` next run avoids
  re-OCR'ing it → per-message idempotency without a per-message table.
- **Advance the watermark on success only.** On failure leave `lastRunAt`
  untouched so the same window retries; never silently skip receipts.
  **Watch-out:** a 0-image run still counts as success and advances the
  watermark, so an empty/mis-scoped run "uses up" the day — receipts already
  posted before it are then permanently behind the watermark. To reprocess a
  stuck receipt you must roll `lastRunAt` back to before its `createdAt`.
- **Process images regardless of direction (inbound AND outbound), not
  inbound-only.** **Why:** in a "laporan kas" group the receipts are usually
  posted by the paired number itself (owner forwarding nota) → recorded as
  `outbound`/fromMe. An inbound-only filter silently dropped every owner-posted
  receipt (0 baris, no error). The bot never sends images into these groups, so
  outbound = genuine human-posted photos only.
- **Scheduler dedup compares the watermark to today's cut-off instant**
  (`lastRunAt >= todayCutoffUtc`), NOT to a `lastRunDate` string.
  **Why:** a per-day date guard makes an earlier *manual* run that day suppress
  the scheduled run. Cut-off-instant comparison lets a morning manual run still
  leave the evening scheduled run to fire, while still de-duping a second tick
  inside the matching minute.

## Input formats & number parsing
- **Process photos AND document attachments, not just `mediaType="image"`.**
  Also accept `mediaType="document"` with `application/pdf` (PDF invoices) or
  `image/*` (photo sent "as file"). Exclude other doc kinds (xlsx/docx/zip).
- **PDFs go to the model as a chat.completions `file` content part**
  (`{type:"file", file:{filename, file_data: dataUrl}}`), NOT `image_url`; the
  model reads the PDF directly — no local rasterization (esbuild-safe).
  **Provider-gate it:** only OpenAI models (Replit-managed default + BYOK
  OpenAI) accept the file part; Gemini/OpenRouter OpenAI-compat endpoints do
  not — skip PDFs there (errors++ + warn) instead of firing a doomed request.
  On Drive upload, PDFs must skip `scanDocument` (it expects a raster image).
- **Indonesian number format must be spelled out in the OUTPUT_CONTRACT, not
  left to the per-group prompt.** `.`=thousands, `,`=decimal → "34.000"=34000.
  **Why:** models default to en-US and read the thousands dot as a decimal, so
  "34.000" became `34` in the Sheet even though the group prompt already said
  "tanpa pemisah ribuan". Give explicit examples and forbid dot-as-decimal.

## How to apply
Any "run once daily at a configurable cutoff over messages since last time"
feature in this repo (recaps, digests) should reuse this watermark + cutoff
pattern rather than a midnight window + date-string guard.
