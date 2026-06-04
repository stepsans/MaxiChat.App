# MaxiChat

Indonesian-language WhatsApp AI automation: a hosted dashboard where each user pairs a WhatsApp account and a Baileys-driven backend answers customer chats via a configurable AI + visual chatbot flow.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/api-server run test` — run api-server unit tests (node:test via tsx; `*.test.ts` files; logic under test must stay db-free)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

- AI Review requires a per-group "Instruksi AI" (free-text prompt). It is mandatory: without an instruction the module does nothing (the guard in `runReviewForConfig` throws, and create/save is blocked). There is no built-in default receipt-OCR fallback. The output contract is always enforced on top of the instruction: the model must reply with a JSON **array** of objects keyed by the exact column names — **one object per receipt line item**, so a single nota with N items produces N Sheet rows (whole-nota fields are repeated on each row). Whole-receipt notas (no line items) yield a one-element array. A one-click "Laporan Kas Harian" template fills the instruction + matching per-item columns. `lastRunCount` / the status pill now count Sheet rows ("baris ditulis"), not notas. A "Generate by AI" button (in Output settings, below the spreadsheet selector and above the columns editor) calls `POST /ai-review/generate-columns`, which reads the Instruksi AI and asks the model to propose the output columns ({name, hint}); it's super-admin-only and records AI usage against the owner. It replaces the current columns; the instruction is still mandatory.
- AI Review dedup is purely time-watermark based (`lastRunAt`): each receipt image is read once by arrival time (`createdAt > lastRunAt && <= now`); the watermark only advances on a successful run. Images are processed **regardless of direction** (inbound AND outbound) — in a "laporan kas" group the receipts are frequently posted by the paired number itself (owner forwarding nota), which is recorded as `outbound` (fromMe). Filtering to inbound-only silently dropped every owner-posted receipt. The bot never sends images into these groups, so including outbound only adds genuine human-posted photos. The Sheet is append-only and never read back — **deleting a row in Google Sheets does NOT cause re-extraction**, and already-appended notas are never re-read. Pure parsing helpers (`parseJsonRows`/`toRowObjects`/`cellToString`) live in db-free `ai-review-parse.ts` so they're unit-testable.
- AI token usage is tracked per tenant owner (super admin). Each owner uses their own AI quota; usage by team members rolls up to the owner. The monthly reporting period is anchored on the owner's join date (day-of-month), not the 1st. Visible in the admin app (all owners) and the whatsapp-ai dashboard (each owner's own). No historical backfill — usage accrues forward only.
- Customer labels are **contact-level**, not per-chat: a label is keyed by (owner, phone number) in `contact_labels`, so labeling a number "High Risk" in one channel makes it show on the same number in every other channel of that owner — and on chats created later for that number. The Chat list shows each chat's label chips + a label filter; Dashboard and Analytics show chat counts per label (a contact present in 2 channels counts as 2 chats). Telegram chats use a `tg:<id>` phone key so they never cross-link with WhatsApp numbers.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
