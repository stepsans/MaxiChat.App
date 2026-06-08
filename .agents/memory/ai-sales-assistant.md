---
name: AI Sales Assistant (Enterprise sales pipeline)
description: Naming invariant, entitlement+permission gating, and pipeline-health semantics for the Enterprise sales pipeline feature.
---

# AI Sales Assistant

The Enterprise sales-pipeline / opportunity feature.

## Naming invariant (load-bearing)
- User-facing AND internal name is ALWAYS "AI Sales Assistant" — NEVER "CRM", anywhere (nav labels, page titles, comments, identifiers).
- **Why:** product decision; "CRM" is banned vocabulary for this surface.

## Entitlement vs permission (two independent gates)
- **Entitlement**: `AuthUser.hasAiSalesAssistant` (from `useGetMe`) = tenant's plan includes the Enterprise feature. Resolved against the OWNER on the backend.
- **Permission**: `usePermissions().menus.opportunities` = per-role CRUD matrix (`opportunities` is a FULL_CRUD menu key; super_admin all-true; agent default-false). Agents are additionally scoped by the route layer to their OWN assigned opportunities — the matrix does NOT express that ownership scope.
- A surface must check BOTH: hide/lock unless `hasAiSalesAssistant && menus.opportunities.canView`; gate mutations on `canEdit`.
- **How to apply:** Layout nav gates a new item via a `requiresAiSalesAssistant` NavItem flag (the nav `isVisible` filter only natively understands `menu`/`roles`, so entitlement needs its own branch reading `user.hasAiSalesAssistant`). Pages must self-guard too (routes are unguarded).

## Pipeline-health "high risk" semantics
- High risk = opportunity is `open` AND `estimatedValueIdr >= highValueThresholdIdr` AND `daysSinceActivity >= staleDaysThreshold`.
- `highValueThresholdIdr = 0` means value never excludes (only staleness matters). `null lastActivityAt` = infinite stale (always passes the staleness leg). staleDays clamps to >= 1.
- Thresholds live on `sales_assistant_settings` (config row; survives tenant-reset). Pure logic in db-free `lib/pipeline-health-build.ts`.

## Kanban board conventions
- Opportunities can have `stageId === null` → a synthetic "Tanpa Stage" column (frontend uses a `"no-stage"` string sentinel since dnd-kit ids are strings; map back to null on drop).
- Dragging onto a terminal stage (`isWon`/`isLost`) must auto-flip the opportunity `status` to `won`/`lost` (else `open`) in the same update.
- Stage DELETE returns 409 when any opportunity still references the stage — the UI must surface "move opportunities first", not a generic error.
- Stage reorder is POST /sales/stages/reorder with the EXACT full set of the owner's stage ids; sortOrder is reassigned by array index in a txn.
