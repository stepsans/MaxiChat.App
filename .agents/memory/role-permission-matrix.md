---
name: Per-role permission matrix
description: How the Supervisor/Agent matrix is enforced end-to-end, and the rule for keeping new routes in sync.
---

The rule: every backend route that the matrix is meant to govern MUST declare `requirePermission(menu, action)` from `lib/role-permissions.ts`. Hiding a button in the UI is not enforcement — the architect review caught settings.PUT and analytics.GET being unprotected even after the matrix shipped.

**Why:** the frontend `usePermissions()` hook drives sidebar visibility and per-page button hiding off `/permissions/me`. If the matching backend route is gated only by the legacy `requireSupervisorOrAbove` / `requireNotAgent` middleware, an agent (or supervisor with a customised matrix) can still call the endpoint directly. The matrix becomes a no-op for that menu.

**How to apply:**
- Adding a new menu to the matrix: add to `PERMISSION_MENUS` in both `artifacts/api-server/src/lib/role-permissions.ts` and `artifacts/whatsapp-ai/src/hooks/use-permissions.ts`, then add a row to the matrix editor.
- Adding a new route under an existing menu: chain `requirePermission("<menu>", "<action>")` after `requireAuth` and any role gate. Layering both is fine — both must pass.
- Saving the matrix: must go through `saveMatrix()`, which wraps all upserts in `db.transaction(...)`. Per-row loops without a transaction allow half-saved matrices on crash.
- Super admin: always-allow is hard-coded in `getEffectivePermissions` and `requirePermission` — never persisted as rows. Don't try to "edit super_admin" in the UI.
- After matrix saves, invalidate both `getGetPermissionMatrixQueryKey()` and `getGetMyPermissionsQueryKey()` on the client so the sidebar updates without a reload.
