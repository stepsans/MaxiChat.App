---
name: AI provider BYOK
description: How per-tenant AI provider (Replit default vs bring-your-own-key) is wired in MaxiChat
---

All AI completions go through ONE resolver: `resolveAiClient(userId)` in
`artifacts/api-server/src/lib/ai-provider.ts` returns `{ client, model }`.
Never reintroduce a hardcoded `openai` import + `gpt-4o-mini` at a call site —
route every new AI call through the resolver so BYOK keeps working.

**Default path is sacred:** missing config row, mode = "replit", OR byok with no
stored key → returns the managed `openai` client + `DEFAULT_REPLIT_MODEL`. This
is the zero-config default and must stay behavior-identical.

**All three providers (OpenAI/Gemini/OpenRouter) use the OpenAI SDK** via
`createOpenAiClient({apiKey, baseURL})` in `@workspace/integrations-openai-ai-server`.
Gemini/OpenRouter are reached through their OpenAI-compatible base URLs
(`PROVIDER_DEFAULTS`). api-server has NO direct `openai` dep — derive the client
type with `ReturnType<typeof createOpenAiClient>`, never `import OpenAI from "openai"`.

**Why baseUrl is SSRF-guarded** (`validateBaseUrl`): a tenant-supplied base URL
flows into outbound HTTP. Without validation a super-admin could hit the cloud
metadata endpoint / internal services. Guard requires https + blocks
loopback/private/link-local/CGNAT literals and localhost-style hostnames.
Applied in PUT, POST /test, AND the runtime resolver (resolver silently falls
back to the provider default for an unsafe stored value). Note: this blocks IP
literals + obvious names only — it does NOT do DNS resolution, so a hostname
resolving to a private IP is not caught (acceptable for a super-admin-gated,
billing-sensitive surface).

**Key handling:** `api_key_enc` stores AES-256-GCM envelope (crypto.ts). Reads
are always masked (`maskedApiKey`, e.g. `sk-…AB12`); plaintext is never returned.
PUT omitting `apiKey` keeps the stored key.
