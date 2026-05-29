---
name: Settings merged-view contract
description: Why GET /settings must always return the tenant+channel merge, never short-circuit on ownerPhone
---

# Settings merged-view contract

MaxiChat settings split into two scopes that are merged on read:
- **Per-channel** (`settingsTable`, keyed on `channel.id`): only `autoReplyEnabled` is live.
- **Tenant/general** (`tenantSettingsTable`, keyed on `channel.userId` = tenant root): `systemPrompt`, `replyDelayMin/Max`, `fallbackMessage`, `flowCooldownMinutes`. One row per tenant, edited only by super_admin.

**Rule:** `GET /settings` and `PUT /settings/general` must always return `getMergedSettings(channel)` for any valid channel — including unpaired channels (no `ownerPhone`).

**Why:** an earlier version short-circuited to a hardcoded `defaultSettingsResponse()` when `!channel.ownerPhone`. That silently dropped saved tenant-wide general settings whenever the active channel had no connected WhatsApp, so a freshly-added channel showed defaults even though the business had configured its prompt. The merge does NOT need `ownerPhone`: channel settings key on `channel.id` and tenant settings key on `channel.userId`, both of which exist before pairing.

**How to apply:** never gate the settings merge on connection state. Reserve any "not connected" 503 strictly for write paths that genuinely require a live WhatsApp (e.g. `PUT /settings/auto-reply`, bio updates), not for reads or tenant-general writes.
