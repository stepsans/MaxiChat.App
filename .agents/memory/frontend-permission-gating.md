---
name: Frontend permission gating (whatsapp-ai)
description: Why hiding a sidebar nav item is NOT enough to gate a page for restricted roles, and how Settings/menus must be guarded.
---

Hiding a menu in the sidebar nav filter does **not** prevent a restricted user (e.g. agent) from reaching the page. In `artifacts/whatsapp-ai/src/App.tsx` every authenticated route (`/settings`, etc.) is rendered with **no per-route guard** — any signed-in user can deep-link to any page by URL. So menu visibility and page access are two separate gates; you must do BOTH.

**Why:** an agent reported the Settings menu/"Balas AI" (autoReplyEnabled) toggle was still usable. The nav filter + backend `requirePermission("settings","edit")` were already correct; the holes were (a) the unguarded route let the page load by URL, (b) the page had zero client gating so the toggle flipped freely in the UI (backend still 403'd on save, but UX implied it worked).

**How to apply:**
- Each gated page self-guards via `usePermissions()`: redirect to `/` in a `useEffect` only when `!isLoading && !menus.<menu>.canView` (gate on the loading flag or you'll bounce super_admin/supervisor mid-load — while loading, `usePermissions` returns all-false for non-super-admins). Render a skeleton while `permLoading`, return `null` when `!canView`.
- Disable mutating controls (toggles, Save) on `!menus.<menu>.canEdit`, and early-return in the submit handler too (covers Enter-key/programmatic submit).
- The Layout nav filter must default a missing `teamRole` to `"agent"` (least privilege), NEVER `"super_admin"` — a fail-open default flashes every menu. `App.tsx` gates rendering on `/auth/me` so `user` is normally defined, but the security default must still fail closed.
- Backend authorization (`requirePermission`, `getEffectivePermissions`) is the real enforcement layer; frontend gating is UX that must stay aligned with it. Default agent matrix: settings all-false (no view/edit); supervisor: settings canView+canEdit true.
