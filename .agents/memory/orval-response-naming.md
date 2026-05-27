---
name: Orval response-schema naming collisions
description: How OpenAPI component naming interacts with orval's generated zod + types barrels.
---

This repo's orval setup emits BOTH:
- a zod schema `export const <OperationId>Response` in `lib/api-zod/src/generated/api.ts`, and
- a TS interface in `lib/api-zod/src/generated/types/<schemaName>.ts` for every named component.

`lib/api-zod/src/index.ts` re-exports both barrels. If a component is named `<OperationId>Response` (e.g. operation `verifyEmail` + component `VerifyEmailResponse`), the same identifier is exported from both barrels → TS2308 ambiguity at codegen typecheck time.

**Why:** the names collide because orval doesn't namespace the two surfaces.

**How to apply:** name response-body components with a distinct suffix that won't collide with `<OperationId>Response`. Convention used here: `Result` (e.g. `EmailVerificationResult`, `ResendVerificationResult`). Inputs (`...Input`) and bodies (orval auto-names `...Body`) don't collide so no special rule there.
