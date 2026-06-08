---
name: OpenAPI inline request body codegen collision
description: Why a POST with an inline requestBody schema can break codegen with a duplicate-identifier (TS2308) error, and the fix.
---

When an operation (e.g. `forwardMessage`) declares its `requestBody` schema
inline, the codegen emits a body type AND a zod schema both named after the
operation (`<OperationId>Body`, e.g. `ForwardMessageBody`). The types barrel and
the zod barrel then both export the same identifier, producing a TS2308
"Module has already exported a member named 'ForwardMessageBody'" collision.

**Fix:** define the request body as a named `#/components/schemas/...`
component (e.g. `ForwardTargetsBody`) and `$ref` it from the operation. The
component name drives the generated type, so it no longer collides with the
operation-derived zod export.

**Trap:** the `$ref` alone is NOT enough — the component name must DIFFER from
the operation-derived `<OperationId>Body`. Naming the `editMessage` body
component `EditMessageBody` still collides (operation derives `EditMessageBody`
too); rename it (e.g. `EditMessageTextBody`) and keep importing the
operation-derived `<Op>Body` in the route. This is why existing components use
non-operation names (`ForwardTargetsBody` for `forwardMessage`,
`StarMessageBody` for `setMessageStar`).

**Why:** the Orval-based codegen derives names independently for the types
output and the zod output; an inline body collapses both onto the operationId.

**How to apply:** never inline a non-trivial `requestBody` schema; always
`$ref` a distinctly-named component. Applies to any new POST/PUT/PATCH op in
`lib/api-spec/openapi.yaml`.
