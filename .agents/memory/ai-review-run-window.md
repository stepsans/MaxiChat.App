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
- **Scheduler dedup compares the watermark to today's cut-off instant**
  (`lastRunAt >= todayCutoffUtc`), NOT to a `lastRunDate` string.
  **Why:** a per-day date guard makes an earlier *manual* run that day suppress
  the scheduled run. Cut-off-instant comparison lets a morning manual run still
  leave the evening scheduled run to fire, while still de-duping a second tick
  inside the matching minute.

## How to apply
Any "run once daily at a configurable cutoff over messages since last time"
feature in this repo (recaps, digests) should reuse this watermark + cutoff
pattern rather than a midnight window + date-string guard.
