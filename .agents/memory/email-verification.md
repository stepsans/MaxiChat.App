---
name: Email verification flow rules
description: Two hard rules that the self-signup email-verification path must obey to stay safe.
---

## Rule 1 — `devVerifyUrl` is dev-only

When no email provider is configured, the helper logs the verification link AND can return it in the API response so a local operator can verify without a real inbox. That return value MUST be gated behind `process.env.NODE_ENV !== "production"`.

**Why:** in production, returning the URL from `/auth/resend-verification` lets anyone with a known email harvest a live verification token without ever owning the mailbox — defeats the entire verification control.

**How to apply:** in the email helper, only populate `devVerifyUrl` in dev. In prod with no provider, fail closed (no link in response, just the server log).

## Rule 2 — verify-email only activates `pending+unverified`

The UPDATE that flips `status='active'` and stamps `emailVerifiedAt` must include `WHERE status='pending' AND email_verified_at IS NULL`, then check the returning rowcount.

**Why:** if an admin later disables the account (status='disabled'), a still-valid token from the original signup email must NOT silently re-enable it. Unconditional update = privilege bypass.

**How to apply:** use a conditional `update().where(...).returning(...)`; if 0 rows updated, look up the current state — if `emailVerifiedAt` is already set, return success (idempotent re-click); otherwise return 400. Always mark the token used regardless, so the link stays single-use.
