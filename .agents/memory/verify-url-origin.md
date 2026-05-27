---
name: Verification / reset link origin
description: Why links emailed to users must derive their origin from configuration, not the request Host header.
---

Any URL we email to a user (verification, password reset, magic link) MUST build its origin from a configured env var (e.g. `PUBLIC_URL`) — never from `req.get("host")` or `req.hostname` in production.

**Why:** in many proxy/CDN setups the Host header is attacker-influenced. If we trust it, an attacker can send a crafted request that produces an email whose link points at `attacker.example` carrying a real, live token. The victim clicks, the token is captured, account taken.

**How to apply:**
- Read `process.env.PUBLIC_URL` first; strip trailing slash.
- If missing AND `NODE_ENV === "production"` → throw, do not silently fall back. The signup/reset endpoint will 500 (loud) instead of leaking tokens (silent).
- In dev only, fall back to `${req.protocol}://${req.get("host")}` for convenience.
