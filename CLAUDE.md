# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# API server
pnpm --filter @workspace/api-server run dev        # run API server (port 5000)
pnpm --filter @workspace/api-server run test       # unit tests (node:test via tsx)

# Frontend apps
pnpm --filter @workspace/whatsapp-ai run dev       # tenant dashboard (Vite)
pnpm --filter @workspace/admin run dev             # platform admin (Vite)

# Workspace-wide
pnpm run typecheck                                  # typecheck all packages
pnpm run build                                     # typecheck + build all packages
pnpm --filter @workspace/api-spec run codegen      # regenerate API hooks + Zod schemas from OpenAPI spec
```

Required env: `DATABASE_URL`

## Architecture

**pnpm monorepo** — Node.js 24, TypeScript 5.9 strict.

### Package layout

| Path | Package | Purpose |
|---|---|---|
| `artifacts/api-server` | `@workspace/api-server` | Express 5 backend, port 5000 |
| `artifacts/whatsapp-ai` | `@workspace/whatsapp-ai` | Tenant dashboard (React + Vite) |
| `artifacts/admin` | `@workspace/admin` | Platform operator dashboard (React + Vite) |
| `artifacts/mobile` | — | Expo mobile app |
| `lib/db` | `@workspace/db` | Drizzle ORM schema + DB client (connects eagerly at import) |
| `lib/api-spec` | `@workspace/api-spec` | OpenAPI spec (`openapi.yaml`) + Orval codegen config |
| `lib/api-client-react` | `@workspace/api-client-react` | Generated React Query hooks |
| `lib/api-zod` | `@workspace/api-zod` | Generated Zod schemas |
| `lib/integrations-openai-ai-server` | `@workspace/integrations-openai-ai-server` | OpenAI SDK wrapper (server-side) |

### Contract-first API

Edit `lib/api-spec/openapi.yaml` → run `codegen` → use generated hooks (client) + Zod schemas (server). Never hand-write what codegen owns. Always `$ref` a named component for request bodies — inline `requestBody` creates a TS2308 collision between the type and the Zod `<Op>Body` name.

### DB schema

`lib/db/src/schema/*` is the source of truth. Key tables: `users`, `channels`, `chat_messages`, `payments`, `invoices`, `subscriptions`, `tenant_quota`, `plans`, `addons`.

**Migrations via raw `psql`** — the repo keeps no drizzle migration history; never run `drizzle-kit push` (it needs a TTY, crashes in agent shell even with `--force`). Apply `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` manually with `psql "$DATABASE_URL"`, then re-run push only to re-sync (it will report no diff).

### API server middleware stack

Public routes → `requireAuth` → `enforceSubscription` (blocks writes for expired tenants) → resource routers.

Webhook routes (`/webhooks/telegram`, `/webhooks/xendit`) mount **before** `requireAuth` — they are authenticated by their own token headers.

## Key Conventions

### Money

All money is **whole-integer Rupiah** (no decimals). OpenAPI `integer` codegens to `zod.number()` which accepts decimals — routes must re-validate with `Number.isInteger` at the boundary.

### Express 5 handlers

Handlers must be typed `async (req, res): Promise<void>`. Do **not** `return res.status(X).json(Y)` — use the two-statement form:

```ts
res.status(400).json({ error: "..." });
return;
```

When mass-editing, single-line unbraced `if` is a trap: `if (cond) return res.X(...)` rewrites to `if (cond) res.X(...); return;` — the `return` becomes unconditional. Always wrap: `if (cond) { res.X(...); return; }`.

### Role model

Three distinct role axes:
- `users.role = "admin"` — platform operator. Gated by `requireAdmin`. Never a paying tenant.
- `users.teamRole = "super_admin"` — a tenant's owner. Gated by `requireSuperAdmin`.
- `users.teamRole = "supervisor" | "agent"` — invited team members whose `parentUserId` points to the owner.

`getEffectiveOwnerUserId(userId)` resolves supervisor/agent → their owning super_admin. All scoping logic pivots on the effective owner id.

Every route the permission matrix governs must chain `requirePermission(menu, action)` from `lib/role-permissions.ts` — hiding a UI button alone is not enforcement.

### Unit tests

`node:test` via `tsx` — tests are `*.test.ts` colocated next to the code. Unit-tested logic must stay **db-free**: `@workspace/db` connects to Postgres eagerly at import and crashes any test that transitively imports it. Keep pure logic in db-free `*-build.ts` / parser modules and test those directly.

### WhatsApp / Baileys

- Every automated send (AI + chatbot flow) must random-delay **per message** + show typing presence using the tenant's `replyDelayMin`/`replyDelayMax` bounds — or the number risks a ban.
- `messages.upsert` handlers must accept all four upsert types (`notify`, `append`, `prepend`, `replace`). The epoch guard inside a per-message loop must be `continue` (not `return`) so a socket flicker doesn't drop the rest of the batch.
- Baileys has no echo-send: a DB row alone never transmits. Every outbound path must call `sock.sendMessage` on the chat's own channel via `getSockForChannel(chat.channelId)`. `getActiveSocket(userId)` is for pairing/guard only, never for sending to an existing chat.
- `loggedOut` (not transient drops) must wipe the auth directory to re-pair; a stale creds file prevents QR generation.

### AI

All AI completions go through `resolveAiClient(userId)` in `artifacts/api-server/src/lib/ai-provider.ts` — never a hardcoded `openai` import at a call site. The api-server has **no direct `openai` dep**; use `ReturnType<typeof createOpenAiClient>` for the type. The `baseUrl` field is SSRF-guarded (`validateBaseUrl`). Every new AI call site must record token usage against the **owner** (member usage rolls up).

### Multi-channel

Chats key on `phone_number`; Telegram reuses it as `tg:<id>`. `user_channel_access` scopes the channel switcher for supervisor/agent; super_admin sees all. Funnel every channel resolver through `getAllowedChannelIds`. Every channel-bound resource send must re-check per-channel assignment.

## Billing & Subscriptions

**Single settlement chokepoint:** every payment (Xendit, manual, wallet) settles through `settlePaymentPaid` — one `db.transaction` doing paid-flip + entitlement grant + invoice creation, idempotent via `WHERE status='pending'`. Plans are applied **before** add-ons inside the same cart (plan activation resets quota to base; add-ons top up afterward).

**Tenant quota:** `tenant_quota` stores **limits only** (plan quota + add-on top-ups). Actual usage is computed live — never denormalize a usage counter.

**Invoices are immutable:** created inside `settlePaymentPaid`'s transaction, idempotent via unique `payment_id`. Snapshot-priced — a later catalog price change never rewrites financial records.

**PDF invoice endpoint** (`GET /billing/payments/:id/invoice`) is binary, deliberately **not** in OpenAPI. Built with `pdf-lib` (not pdfkit — esbuild can't bundle `.afm` fonts). Downloaded via raw `fetch → blob` on the client.

**Owner Infinity Plan:** a single unlimited/never-billed owner is an RBAC boolean flag (`users.is_infinity_owner`), not a catalog plan. Single resolver: `isInfinityOwner(ownerId)` in `infinity-owner.ts`. Every quota/limit/billing/read-only gate and every display surface that renders `users.plan` must honor this flag.

**Billing v2 features** (overage, dunning, wallet, proration, retention, finops) are all **default-disabled and additive** — zero behavior change when disabled. Wallet-first checkout only activates when balance fully covers the cart.

**Xendit webhook** must scope reconciliation to `provider='xendit'`. The manual payment **poller** is the only allowed path to settle manual rows.

## Deep Reference

Non-obvious lessons are indexed in `.agents/memory/MEMORY.md` with individual files in `.agents/memory/`. Consult these before touching billing settlement, Baileys pipelines, multi-channel send, or permission enforcement.
