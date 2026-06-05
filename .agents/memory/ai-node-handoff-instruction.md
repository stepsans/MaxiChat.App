---
name: AI-node per-node instruction
description: How the chatbot flow "ai" handoff node carries a custom AI instruction and how its lifetime is scoped.
---

The chatbot flow `ai` node is a handoff: it sends an optional intro then mutes the Default trigger (`defaultMutedUntil`) so the general AI auto-reply answers subsequent messages. It can also carry optional per-node overrides: `aiInstruction` (a per-node AI "persona") and `knowledgeIds` (restrict the AI's knowledge-base reference to specific entries). Both ride the exact same handoff mechanism — add new per-node AI overrides the same way.

Rule: the per-node instruction is NOT passed to the model at handoff time (the AI node doesn't generate a reply itself). It is persisted into `chat.flowState` alongside `defaultMutedUntil`, and the general auto-reply path (`maybeTriggerAutoReply`) re-reads fresh flowState and applies it as `aiInstructionOverride` to `generateAiReply` **only while `Date.now() < defaultMutedUntil`** (the active handoff window). It expires naturally with the cooldown — never lingers onto later unrelated replies.

**Why:** AI replies happen on *later* messages via the normal auto-reply path, not inside the flow run, so the instruction must survive across messages but must also self-expire or it would silently steer every future reply.

**How to apply:** `flowState` is a JSONB superset with optional keys (`flowId`/`currentNodeId` mid-question, `defaultMutedUntil` post-exit, `aiInstruction` only on AI-node handoff). Any new flowState reader must treat all keys optional. Override expiry is evaluated at **generation time** (inside the delayed reply callback), not message-arrival time — acceptable because the instruction is meant to apply while the handoff is active. The instruction is appended to the system prompt between `tenant.systemPrompt` and the hardcoded `ATURAN MUTLAK` block, so the catalog/knowledge hard rules still win.
