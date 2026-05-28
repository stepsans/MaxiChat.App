---
name: Express 5 handler conventions
description: How Express 5 + strict TS in this repo forces a specific handler return style, and the bulk-rewrite trap that follows.
---

In the api-server (Express 5, TS strict), route handlers must be typed `async (req, res): Promise<void>` and must NOT `return res.status(X).json(Y)` — that returns a `Response`, which is not assignable to `void`. Convert to `res.status(X).json(Y); return;` instead.

**Why:** Express 5's `RequestHandler` type tightened; the older "return whatever res returns" idiom now fails TS2322 across hundreds of sites.

**How to apply:**
- New handlers in `artifacts/api-server/src/routes/`: annotate `Promise<void>` and use the two-statement form for early exits.
- When mass-fixing existing files, do NOT use a naive regex that just replaces `return res.X(...)` with `res.X(...); return;` — it breaks single-line unbraced ifs:
  - `if (cond) return res.status(400).json(...)` rewrites to `if (cond) res.status(400).json(...); return;` — the `return;` becomes unconditional and the handler exits early on EVERY request. This bit us in `chats.ts` `PATCH /:id/assign` and went undetected by typecheck because the body is `void`-returning either way; only an architect pass / smoke test caught it.
  - Fix: always wrap with `if (cond) { res.X(...); return; }`. After any bulk pass, grep `rg -nP -U 'if \([^{}\n]+\)\s*\n\s+res\.[a-z]+\('` over the routes dir to find leftovers.
