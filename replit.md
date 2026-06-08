# MaxiChat

Indonesian-language WhatsApp/Telegram AI automation: a hosted dashboard where each user pairs a messaging account and a Baileys-driven backend answers customer chats via a configurable AI + visual chatbot flow.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/api-server run test` — api-server unit tests (node:test via tsx; `*.test.ts`; logic under test must stay db-free)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas from the OpenAPI spec
- Required env: `DATABASE_URL`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 · DB: PostgreSQL + Drizzle ORM · Validation: Zod (`zod/v4`) + `drizzle-zod`
- API codegen: Orval (from OpenAPI spec) · Build: esbuild (CJS bundle)

## Conventions (load-bearing)

- **Migrations via raw `psql`** — the repo keeps no drizzle migration history; never `drizzle-kit push` (it needs a TTY and crashes in the agent shell / post-merge).
- **All money is whole-integer Rupiah.** OpenAPI `integer` codegens to `zod.number()` (accepts decimals), so routes must re-check `Number.isInteger` at the boundary.
- **Contract-first**: edit the OpenAPI spec → `codegen` → use generated hooks (client) + Zod schemas (server). Don't hand-write what codegen owns.
- **db-free pure modules + node:test**: unit-tested logic lives in db-free `*-build.ts` / parser modules (because `@workspace/db` connects eagerly); db-backed tests use the shared dev DB with baseline-delta assertions.
- **Single settlement chokepoint**: every payment (Xendit, manual, wallet) settles through `settlePaymentPaid` — one `db.transaction` doing paid-flip + entitlement grant + invoice creation, all-or-nothing, idempotent via `WHERE status='pending'`.
- **Platform admin vs tenant super_admin**: `requireAdmin` = platform operator (role `admin`); `requireSuperAdmin` = a tenant's owner. Never conflate.

## Where things live

- DB schema: `lib/db/src/schema/*` (source of truth; `invoices.ts`, `payments.ts`, `subscriptions.ts`, etc.)
- API contract: `artifacts/api-spec` (OpenAPI → generated hooks/schemas)
- Backend: `artifacts/api-server/src` (`routes/`, `lib/`)
- Apps: `artifacts/whatsapp-ai` (tenant dashboard), `artifacts/admin` (platform operator), `artifacts/mobile` (Expo)
- See the `pnpm-workspace` skill for workspace structure + TypeScript setup.

## Product

- **AI Review** (receipt/nota → Google Sheet): requires a mandatory per-group "Instruksi AI" prompt (no built-in OCR fallback). Output contract is always enforced on top: a JSON **array**, one object per receipt line item → one Sheet row each. Dedup is time-watermark based (`lastRunAt`, advances only on success); items processed regardless of direction (owner-forwarded notas are `outbound`). Accepts photos + document attachments (PDF/image mime); PDF input is OpenAI-only. The global contract spells out Indonesian numerics (`.`=thousands) so "34.000"→`34000`. Sheet is append-only, never read back. Pure parsers in db-free `ai-review-parse.ts`.
- **AI token usage** is attributed to the tenant **owner** (member usage rolls up). Monthly period anchored on the owner's join day-of-month, not the 1st. No backfill — accrues forward only.
- **Outbound blue ticks**: `chat_messages.status` (`sent`|`delivered`|`read`; null≈sent) advanced forward-only by Baileys listeners on `key.fromMe` events, with a SQL rank guard so an out-of-order signal can't downgrade. db-free parsers in `lib/chat-read-sync.ts`.
- **Cross-device read sync**: when a chat is read on any linked device, MaxiChat clears its own unread badge (~5s, poll-backed). All read paths converge on one causally-guarded `clearUnreadUpTo` (clears only when the read point covers the latest message). Skips `key.fromMe`. Out of scope: Telegram, websocket/push.
- **Customer labels** are **contact-level** (keyed by owner + phone in `contact_labels`), so a label follows a number across every channel of that owner. Telegram uses a `tg:<id>` phone key to avoid cross-linking with WhatsApp numbers.
- **Reset Database Tenant** (Settings → Database, super-admin): wipes one tenant's *operational* data (chats/messages, labels, snapshots, AI usage, uploaded files + Object Storage blobs) but never the account/subscription/plan/quota/channels/settings/products, and never crosses tenants. **Ordering is load-bearing**: sweep Object Storage prefix FIRST, then all DB deletes + audit insert in ONE transaction (blobs-first = recoverable orphan rows, not orphan blobs). Two-step `RESET` confirmation in the UI.

## Subscriptions & Billing

Self-serve **Hybrid** model: prepaid base **plan** + paid **add-ons/top-ups** (extra users, channels, AI tokens). Add-ons may exceed plan quotas.

**Catalog & quotas**
- Plans & add-ons are **admin-configurable DB catalog rows**, never hardcoded: `plans` (`key` UNIQUE = `users.plan`) + `addons`. Platform-admin CRUD via `/admin/plans` + `/admin/addons` (admin app "Paket & Add-on" tab). Plan delete blocked (409) when any user references its key — archive via `isActive=false`; plan `key` is immutable.
- `tenant_quota` holds **limits only** (plafon = plan quota + add-on top-ups); actual usage is computed live by the metered billing engine (ceil-bucket math). `payments` is the purchase ledger.
- **Owner Infinity Plan**: a single unlimited/never-billed owner is an RBAC boolean flag (not a catalog plan), resolved everywhere via `isInfinityOwner()`; bypass lives in `getEffectiveSubscription`.

**Payment gateways** (operator picks active provider in admin "Gateway Pembayaran" tab)
- **Xendit**: hosted invoices. Credentials are admin-configurable, stored AES-256-GCM-encrypted in singleton `payment_gateway_config` (DB-first, per-field env fallback `XENDIT_SECRET_KEY`/`XENDIT_CALLBACK_TOKEN`; masked reads). Inbound webhook `POST /webhooks/xendit` is mounted before `requireAuth` (authed by `x-callback-token`), reconciles before ACK, 500s on failure so Xendit retries.
- **Manual** ("Otomatis"): singleton `payment_method_settings` (active provider + bank fields + verification Google Sheet). Checkout writes a PENDING row to the Sheet; operator flips Status→`LUNAS`; a 60s poller settles via `settlePaymentPaid`. Fails fast (502) if bank/Sheet unconfigured or the append throws.
- Both manual + Xendit share the `maxichat-pay-<id>` externalId, so webhook reconciliation is scoped to `provider='xendit'` and the **poller is the only path allowed to settle manual rows**.

**Checkout & invoices**
- Tenant checkout is a **cart** = ONE `payments` row (`kind="cart"` + `line_items` jsonb snapshot). Plans single-select (qty 1); add-ons qty N. Settlement applies **plans BEFORE add-ons** (plan activation resets quota to base). `enforceSubscription` exempts `/billing` so EXPIRED tenants can still renew.
- **Invoices are immutable, snapshot-priced** (`invoices` + `invoice_line_items`) — the source of truth for revenue/history; a later catalog price change never rewrites financial records. Created INSIDE `settlePaymentPaid`'s txn, idempotent via UNIQUE `payment_id`. `source` = `payment` vs `monthly_close`.
- **PDF invoice** `GET /billing/payments/:id/invoice` (binary, deliberately NOT in OpenAPI; downloaded via raw `fetch`→blob): built with **pdf-lib**, reads the frozen invoice snapshot so editing/disabling tax never rewrites historical PDFs.

**Billing v2 enterprise features** (all additive, **default-disabled = zero behavior change**, never break existing)
- **Tax/PPN** (`tax_settings`): pure `computeInvoiceTotals` (inclusive carves tax out, total unchanged; exclusive adds on top). Payment-sourced invoices **force inclusive** so total always == collected amount.
- **Storage enforcement** (`storage_settings`): no-op unless enabled; bypasses Infinity owner; wired ONLY into user-initiated uploads (products/flows image upload → 413), NEVER into inbound media or send-then-persist chat paths.
- **Overage**: `lib/overage-build.ts` → `usage` invoice lines (token blocks + storage GB-day above plafon) inside monthly close.
- **Dunning** (`dunning_settings`, `invoice_dunning_log`): `lib/dunning-build.ts` decides escalation from due-date age; scheduler sweeps overdue invoices idempotently (reminder→suspend→terminate).
- **Wallet/Credit** (`tenant_wallet`, `wallet_transactions`): FIFO-expiry; checkout has a wallet-first fast path used only when balance FULLY covers the cart.
- **Proration**: `POST /billing/change-plan` + `/billing/change-quota` (upgrade → prorated charge; downgrade → prorated wallet credit applied immediately). `ProrationResult.mode` = charge|credit|applied.
- **Retention purge**: `lib/retention-build.ts` cutoff = `min(tenant setting, plan cap)`; dry-run-capable, blob-first, never touches financial rows.
- **Revenue/FinOps**: invoice-grounded MRR/ARR/ARPU/churn (`lib/finops.ts`, `/admin/finops`) + per-day recognition (`lib/revenue-recognize.ts`). **DRIFT**: legacy `computeRevenue` was kept as a SEPARATE surface (not destructively rewired) — the invoice-grounded finops surface satisfies the "rewire to invoices" requirement additively.
- Monthly close: a daily scheduler raises one `monthly_close` invoice per active owner/period, idempotent via deterministic invoice number + unique index.

## Architecture decisions

- **Multi-channel** (WhatsApp + Telegram): chats key on `phone_number`, Telegram reuses it as `tg:<id>`. Outbound always binds to the chat's OWN channel via `getSockForChannel(chat.channelId)`; Baileys has no echo-send, so a DB row alone never transmits.
- **Per-channel access scope**: `user_channel_access` scopes the whole channel switcher for supervisor/agent; super_admin sees all. Funnel every channel resolver through `getAllowedChannelIds`.
- **AI is BYOK-capable**: all AI calls go through `resolveAiClient` (Replit-managed default is behavior-identical; baseUrl is SSRF-guarded). Every new AI call site must record usage against the owner.
- **WhatsApp outbound pacing**: every automated send (AI + flow) random-delays per message + shows typing presence, or the number risks a ban.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- Deep, non-obvious lessons live in `.agents/memory/` (agent memory index). This README is the high-level map.
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
