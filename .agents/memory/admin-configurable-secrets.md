---
name: Admin-configurable encrypted secrets (DB-first + env fallback)
description: Pattern for moving an operator secret (e.g. Xendit keys) from env-only to an admin-editable, encrypted DB row without breaking existing deploys.
---

When making a platform secret admin-editable instead of env-only (e.g. the Xendit
secret key + webhook callback token):

- Store it in a **singleton DB row** keyed by a UNIQUE `provider` column, with the
  value **encrypted at rest** via the existing AES-256-GCM helpers
  (`encryptString`/`decryptString`, key derived from `SESSION_SECRET`). Mirror the
  `ai_provider_config` table's masking discipline.
- Resolve credentials **DB-first with per-field env fallback**, so existing
  deployments keep working until an admin saves a row. An `is_active=false` row is
  treated as if absent (env fallback only) — gives an on/off switch without
  deleting keys.
- **Reads must be masked**: never return the raw secret to the client. Expose only
  `configured` booleans, the `source` (db|env), and a `last4`. Decrypt only at
  use-time on the server.
- The getter functions become **async** (they hit the DB). Audit every caller and
  `await` them — even constant-time token-verify helpers. Decrypt failures (e.g.
  `SESSION_SECRET` rotated) must be caught + logged and treated as "not
  configured", never thrown, so a bad row can't take down checkout/webhook.

**Why:** env-only secrets need a redeploy to change and can't be self-served by the
operator; this keeps secrets encrypted + masked while staying backward compatible.

**How to apply:** for a singleton config row, write it with an **atomic
`INSERT … ON CONFLICT(provider) DO UPDATE`** that lists ONLY the columns being
changed in the conflict SET (omitted fields preserved, explicit `clear` flags set
NULL). A select-then-insert gap races the unique index on concurrent first writes
and 500s. Apply the table via raw `psql` (this repo keeps no drizzle migration
history).
