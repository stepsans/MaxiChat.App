---
name: zod v4 record is exhaustive
description: z.record(enumKey, value) in zod v4 requires ALL enum keys; use partialRecord for sparse payloads
---

In zod v4 (`import { z } from "zod/v4"`), `z.record(enumOrLiteralKey, valueSchema)`
is **exhaustive** — it rejects any object missing one of the enum's keys with
`invalid_type` issues. This differs from zod v3 where such records were partial.

**Why it bit us:** the permission editors (UserPermissionEditor /
PermissionMatrixEditor) send only the CHANGED cells (diffed against the role
default) — a sparse object. An exhaustive `z.record` rejected every partial save
with HTTP 400 "Invalid payload".

**How to apply:** for any endpoint that accepts a sparse object keyed by a
known enum/union, use `z.partialRecord(KeySchema, ValueSchema)`, not `z.record`.
Reserve `z.record` for when the client truly must send every key.
