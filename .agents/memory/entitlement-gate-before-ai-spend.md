---
name: Entitlement gate before AI spend
description: Premium/entitled-only AI features must check the entitlement BEFORE any model call, not after.
---

# Entitlement gate before AI spend

For any entitled-only AI feature (e.g. the Enterprise-only AI Sales Assistant
detection engine), the entitlement check (`ownerHasSalesAssistant(ownerUserId)`)
MUST run BEFORE the model call / persistence, not after.

**Why:** A first cut gated *after* `analyzeAndPersistChat`, reasoning the insight
was "already produced". That still spent tokens and persisted rows for
non-entitled tenants — exactly what the entitlement is meant to prevent. The
detection worker has only `chatId`, so resolve owner cheaply first
(chat → channel → `resolveOwnerUserId`) and bail before any AI work.

**How to apply:** In a fire-and-forget detection/worker path, resolve the tenant
owner from the trigger id, check entitlement, return early if not entitled, and
only then call the AI service. Same rule for any new entitled AI call site.

**Related:** chat-keyed read endpoints (insights, etc.) must also enforce
per-channel access (`getAllowedChannelIds`), not just owner scope — an agent
can otherwise read insights for chats in channels they can't see. See
`resource-channel-scope-on-send.md` / `per-channel-chat-access.md`.
