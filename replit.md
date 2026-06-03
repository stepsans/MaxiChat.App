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

- AI Review requires a per-group "Instruksi AI" (free-text prompt). It is mandatory: without an instruction the module does nothing (the guard in `runReviewForConfig` throws, and create/save is blocked). There is no built-in default receipt-OCR fallback. The JSON-keyed-by-column-names → Google Sheet output contract is always enforced on top of the instruction, regardless of what the instruction says. A one-click "Laporan Kas Harian" template fills the instruction + matching columns.
- AI token usage is tracked per tenant owner (super admin). Each owner uses their own AI quota; usage by team members rolls up to the owner. The monthly reporting period is anchored on the owner's join date (day-of-month), not the 1st. Visible in the admin app (all owners) and the whatsapp-ai dashboard (each owner's own). No historical backfill — usage accrues forward only.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
