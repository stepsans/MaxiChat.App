---
name: Flow node-data zod schema must mirror OpenAPI
description: Why new chatbot-flow node.data fields silently vanish on save unless added to the api-server's hand-written zod schema
---

The api-server validates the chatbot-flow graph with its OWN hand-written zod
schema (`routes/flows.ts` `FlowNodeSchema.data`), separate from the generated
OpenAPI/codegen schema. It is a plain `z.object({...})`, which **strips unknown
keys by default**.

**Rule:** any new `node.data` field added to the OpenAPI `FlowNode.data` (and the
frontend FlowEditor) MUST also be added to `FlowNodeSchema.data` in
`artifacts/api-server/src/routes/flows.ts`. The graph is stored verbatim from
this validated object (PATCH `/flows/:id` and POST `/flows/import`), so a missing
field is silently dropped on save — the toggle/value never persists and the
runtime feature never fires.

**Why:** the "AI Generate" (`aiRephrase`) toggle on question nodes never saved —
the field existed in OpenAPI, the FlowEditor, and the runtime
(`whatsapp.ts` reads `node.data.aiRephrase`), but `FlowNodeSchema.data` omitted
it, so zod erased it before the DB write.

**How to apply:** treat `FlowNodeSchema.data` ↔ OpenAPI `FlowNode.data` ↔
FlowEditor node-data type as a three-way contract that must change in lockstep.
