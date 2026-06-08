---
name: Storage enforcement (additive, opt-in)
description: How the FASE C storage-quota enforcement was made safe — opt-in, fail-open, and never blocking inbound media.
---

# Storage-quota enforcement: the safety invariants

Storage enforcement (block uploads over the plafon) is a high-risk feature: a
naive chokepoint at the storage layer can silently break core messaging or
drop inbound customer media. It was built as a strictly additive, opt-in layer.

## The non-negotiable invariants

1. **Default-disabled = zero behavior change.** The policy is a singleton DB row
   whose default is `enforcement_enabled = false`. The enforce helper short-
   circuits to "ok" when disabled, so nothing changes until an operator turns it
   on. (Same pattern as the tax/PPN config.)
2. **Never block inbound media ingestion.** Enforcement is wired ONLY at
   user-INITIATED asset-upload routes (product image, flow image). It is NOT at
   the storage chokepoint (`saveTenantMedia`) and NOT on any inbound/system path
   (WhatsApp `messages.upsert`, status archival). Blocking the storage layer
   itself would drop customer photos = data loss.
3. **Do not enforce on send-then-persist paths.** Chat media sends transmit over
   WhatsApp FIRST, then persist to storage. Blocking at the persist step records
   a "sent but not stored" inconsistency, and blocking the whole handler would
   stop the operator from replying to a customer. These were deliberately left
   out; a correct version needs a PRE-send quota check (future follow-up).
4. **Fail-open config read.** `getStorageConfig` never throws — on any DB error
   it returns the disabled fallback, so a config-table problem can never block
   uploads.
5. **Bypass the unbillable tenants.** The check bypasses `isInfinityOwner` and
   any non-positive (unprovisioned) limit = always writable.

**Why:** the prime project constraint is "never break existing features;
additive/gradual/safe." Storage enforcement is exactly the kind of feature
where an over-broad chokepoint causes silent data loss, so the blast radius is
kept to explicit user uploads only.

## A subtle client/server contract trap

The dashboard storage bar reads an operator-configured `warnPercent` with a
`warnPercent > 0 ? warnPercent : 80` fallback. If the server allowed `0`, a
saved `0` would be silently rendered as `80`. Fix: the server rejects
`warnPercent < 1` (bound 1..100), so a saved value is always faithful. General
rule: when a client treats a sentinel (0/null) as "use default", the server
must forbid that sentinel as a *saved* value, or the two diverge.
