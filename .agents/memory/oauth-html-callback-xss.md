---
name: OAuth callback HTML rendering — escape everything
description: HTML pages rendered from OAuth callback handlers must escape all dynamic interpolation, not just `<`. The `error` query param, account email, and upstream API error messages are attacker-controllable.
---

# OAuth callback HTML — escape every interpolated field

OAuth callback endpoints (e.g. `/api/credentials/oauth/callback`) typically render a small HTML page so the popup window can show success/error and `postMessage` back to the opener. Three input sources flow into that page and **all** are attacker-influenced:

1. `?error=` query parameter — the attacker fully controls it by linking a logged-in victim to `/oauth/callback?error=<payload>`.
2. The account email returned by the provider's userinfo endpoint (Google honors arbitrary UTF-8 in profile fields).
3. The error description object from the token-exchange failure path.

**Rule:** escape `& < > " '` on every dynamic field before interpolation. A partial replace like `String(detail).replace(/</g, "&lt;")` is **not enough** — `>`/`"`/`'` are still live and an attacker can break out of an attribute or close a tag.

**Why:** A reflected XSS here runs on the application origin with the victim's authenticated session cookie. From there an attacker can hit any same-origin API the user can.

**How to apply:**
- Define one `escapeHtml(s)` helper inside the handler.
- Pass already-safe-HTML strings (e.g. `<b>${esc(email)}</b>`) into the renderer via a `messageHtml` parameter so the boundary between "trusted markup" and "untrusted data" is explicit at every call site.
- Don't forget the `<title>` tag — it interpolates the same dynamic string.
