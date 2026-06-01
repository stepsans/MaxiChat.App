---
name: AI token usage attribution + join-anchored billing period
description: How AI token usage is captured per tenant and how the monthly period is anchored on the owner's join date.
---

# AI token usage tracking

Usage is attributed to the tenant OWNER (super_admin), never an invited member.
`resolveAiClient(userId)` resolves the owner internally and returns
`{ provider, ownerUserId }` alongside `{ client, model }`; the call site passes
`ownerUserId` to `recordAiUsage`. A member's calls roll up to the owner.

**Why:** billing is per-tenant; each owner uses their own AI quota. Reading the
AI provider config for the OWNER (not the passed member id) is intentional —
BYOK config is owner-owned and shared across the tenant's team.

**How to apply:** any NEW AI call site must also call `recordAiUsage` with the
owner id, or that usage goes uncounted. There is exactly one capture point today
(`generateAiReply` in whatsapp.ts) which both WhatsApp and Telegram route
through; if a second independent completion path is added, instrument it too.
Capture is best-effort: `recordAiUsage` never throws and is invoked via `void`
so a failed usage write can never fail a customer reply.

# Join-anchored billing period

`computeBillingPeriod(joinDate, now)` returns `[start, end)` in UTC, anchored on
`users.createdAt` day-of-month — NOT the 1st. Anchor day 29/30/31 clamps to the
last day of shorter months. Reporting endpoints filter `created_at >= start AND
< end`.

**Why:** the product requirement is a per-owner monthly cut-off tied to when
they joined, so two owners reported side-by-side can be on different windows.

**How to apply:** never assume calendar-month boundaries for usage windows;
always go through `computeBillingPeriod`. No historical backfill exists — the
table only accrues from when capture shipped, so pre-feature usage is unknowable.
