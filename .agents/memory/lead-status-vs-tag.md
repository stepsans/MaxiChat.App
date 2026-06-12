---
name: leadStatus vs tag separation
description: chats.tag is auto-router-owned; manual lead classification lives in a separate chats.lead_status column
---

`chats.tag` is written by the auto-routing classifier (`chat-classifier.ts`: sales/complaint/etc). It is NOT a manual field.

Manual lead classification is a SEPARATE column `chats.lead_status` (enum `none|lead|not_lead`, default `none`).

**Why:** the two are dual-purpose if merged — auto-routing would clobber a human's lead label and vice-versa. The user explicitly asked for a separate field.

**How to apply:** any UI/analytics about "leads" reads `leadStatus`, never `tag`. Never reuse `tag` for manual marking. AnalyticsSummary lead metrics are `leads`/`notLeads`/`leadRate` (computed from `leadStatus`), not the old hot/cold/closing tag-derived fields. `leadStatus` is left OPTIONAL in OpenAPI; backend always returns it via row spread + DB default, clients guard with `?? "none"`.
