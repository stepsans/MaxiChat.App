---
name: google-auth-library is transitive
description: Why `google-auth-library` must not be added to api-server's package.json, and how to type OAuth2 clients without it.
---

`googleapis` (installed in api-server) re-exports OAuth2 via `google.auth.OAuth2`, but `google-auth-library` itself is a TRANSITIVE dependency — it is NOT listed in api-server's package.json and must not be added.

**Why:** Adding it as a direct dep creates two copies in the dep tree (the transitive one used internally by googleapis + the direct one), which produces `OAuth2Client` types that are nominally different and breaks assignability when passing the client to `google.sheets({ auth })` etc. It also drifts independently from whatever version googleapis pins.

**How to apply:**
- To type an OAuth2 client, use `InstanceType<typeof google.auth.OAuth2>` — works for params, return types, and factory signatures.
- Do NOT write `import("google-auth-library").OAuth2Client` or add a top-level import from `google-auth-library`.
- The same rule applies to any other transitive Google SDK type — always reach it through `googleapis`.
