---
name: AI Sales Assistant auto follow-up engine
description: Non-obvious rules for the Enterprise auto follow-up scheduler (cancel-on-reply, gating, send path).
---

# Auto follow-up engine (Enterprise "AI Sales Assistant")

The hourly `startFollowUpScheduler` sweep only loads candidate opportunities that are
`status='open' AND waiting_status='waiting_customer'`, gated per-owner via
`ownerHasSalesAssistant()`. Toggle `autoFollowUpEnabled` (default OFF) decides
recommend-only (insert `pending` row, `generatedMessage=null`, audit `follow_up_recommended`)
vs send (claim sequence → `sendFollowUpOnChannel` → flip `sent` + audit `follow_up_sent`).
Cap is `MAX_FOLLOW_UPS=3`, counting only `status='sent'` rows; timing anchors off the
Last Meaningful Interaction (filler messages skipped). WhatsApp-only.

**Cancel-on-reply must NOT live inside the per-candidate loop.** The instant a customer
replies, `waitingStatus` flips away from `waiting_customer` and the deal drops out of the
candidate set entirely — so a per-candidate cancel path would never see it again and the
stale `pending` recommendation would linger forever. Cancellation runs as a SEPARATE pass
(`cancelStalePendingFollowUps`) over ALL `pending` rows whose opportunity is no longer
open+waiting_customer, independent of the candidate filter. Use SQL `IS DISTINCT FROM` so a
NULL `waitingStatus` also counts as "not waiting" (plain `<>`/`ne` skips NULLs).

**Why:** code review flagged that replied deals leave orphaned recommendations because the
sweep filter excludes them.

**Exactly-once send:** holds within a single sequential sweep (for-loop + unique
`(opportunity_id, sequence)` index + nextSequence = sentCount+1). Deployment is a single
Reserved VM (one process), and the scheduler has an in-process `followUpSweepRunning` guard
so a long sweep can't overlap the next tick. True multi-process safety would need a per-owner
advisory lock (the flow-engine pattern), not currently required.
