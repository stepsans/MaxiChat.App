---
name: Deploy repl-layer includes whole filesystem
description: Why publish fails with HTTP 413, and why this Baileys app needs Reserved VM not autoscale.
---

The Replit publish "repl layer" snapshots the **entire workspace filesystem**, not just
git-tracked files. `.gitignore` does NOT exclude a dir from the deploy layer.

**Why:** `artifacts/api-server/media/` (local WhatsApp media store, `process.cwd()/media`,
served at `/api/media`) is gitignored but accumulated ~31GB / ~22k files during dev. At
publish it blew the blob upload limit: `failed to push repl layer ... HTTP 413 Request
Entity Too Large` (after ~40min of retries). The build itself succeeded — failure is the
push/promote step, not code.

**How to apply:**
- Before publishing, keep runtime-cache dirs empty: `rm -rf artifacts/api-server/media`
  (gitignored, code recreates via `fs.mkdir(MEDIA_DIR,{recursive:true})`). Same risk for
  `.whatsapp-auth/`.
- Durable fix: move media to **object storage** (see object-storage skill) so deploys stay
  small AND media persists in production.

**Autoscale is the wrong target for this app.** api-server is deployed as
autoscale/cloud_run, but it (a) holds persistent Baileys WhatsApp sockets, (b) stores auth
creds + media on local (ephemeral, non-shared) disk, (c) runs in-process schedulers (manual
payment poller, AI review). Autoscale is stateless, ephemeral-fs, and spins down when idle —
all three break. Recommend the user switch the deployment to **Reserved VM** in the
Deployments pane (agent cannot change deployment type programmatically).
