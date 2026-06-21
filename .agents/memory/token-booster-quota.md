---
name: Token grant vs booster two-bucket quota
description: How the AI token plafon splits into a per-period grant and 90-day paid boosters, and how each is computed/consumed.
---

# Two buckets: grant (lapses) + booster (90-day, carries over)

LOCKED spec B. The AI token plafon is TWO separate buckets, never merged:

- **Grant (Ember A)** — the active plan's monthly allowance. Lives in
  `tenant_quota.tokenLimit`. Use-it-or-lose-it: lapses at period end. Computed
  LIVE (`grantRemaining = max(0, tokenLimit − periodUsage)`) — never a stored
  counter.
- **Booster (Ember B)** — paid `token` add-ons. Live in the dedicated
  `token_boosters` table (`remainingTokens` is a STORED decrementing counter,
  because boosters carry across period resets — a live computation would wrongly
  "restore" used booster tokens when the period rolls over). `expiresAt =
  purchasedAt + 90 days`.

## Consumption order (B3): grant first, then boosters FIFO by soonest expiry
`recordAiUsage` decrements boosters best-effort AFTER inserting the usage row:
only the slice of a charge that overflows past the grant hits boosters
(`boosterOverflowForCharge`), allocated soonest-expiry-first
(`planBoosterConsumption`, both pure/db-free in `booster-consume.ts`). A cheap
indexed early-exit skips the whole path for owners with no boosters (the common
case) — without it, every AI call for a `grant=0` tenant logs a spurious
"unmet overflow" warning. It's metering, not settlement: rare concurrent
under-debit is acceptable; the real spend gate is the hard-block.

## A 'token' add-on settles as a BOOSTER, not a grant top-up or wallet credit
In `addAddonToQuota`, `addon.type === "token"` calls `grantBooster()` (inserts a
`token_boosters` row, 90-day expiry) INSIDE settlePaymentPaid's txn — it does NOT
touch `tenant_quota.tokenLimit` and no longer calls the credit-wallet
`addPaidCredits`. channel/user_seat/storage add-ons still top up `tenant_quota`.

## Display math (`/ai-usage/me`)
`tokenRemaining = grantRemaining + boosterRemaining` — do NOT derive it from
`tokenLimit − used` (boosters are already decremented, so that double-subtracts
overflow). The progress-bar plafon is a STABLE `tokenLimit = used + remaining`
(constant as grant drains into boosters). `tokenLimit === 0` means UNCAPPED
(infinity owner / unprovisioned trial) → helpers read it as "no cap" (0%, ok),
never depleted. Daily `expireBoosters()` sweep flips past-expiry rows to
`expired`. See [[hybrid-subscription-foundation]], [[cart-single-payment-settlement]].
