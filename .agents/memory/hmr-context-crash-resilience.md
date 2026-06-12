---
name: HMR fast-refresh context desync white-screens the app
description: Why a correctly-nested provider can still throw "must be used within X Provider" during dev editing, and how to make cosmetic consumers resilient.
---

# HMR fast-refresh context desync can white-screen the whole app

Symptom: repeated runtime errors like `useActiveChannel must be used within
ChannelProvider` / `useNotificationSound must be used within
<NotificationSoundProvider>` thrown from a component (e.g. `Layout`) that is
**already correctly nested inside both providers** in `App.tsx`. The app loads
fine on a full page reload; the errors only appear during an active editing
session with lots of HMR churn.

**Root cause:** a context module that mixes a Provider *component* export with
hook/non-component exports cannot be Fast-Refreshed by `vite-plugin-react`, so
Vite fully *invalidates* the module on edit (console: `Could not Fast Refresh
("X" export is incompatible)` / `invalidate ...: Could not Fast Refresh (new
export)`). During that invalidation the consumer can briefly resolve a *fresh*
module instance of the context while the Provider higher in the tree is still the
*old* instance → `useContext` returns null → a strict hook that throws-on-null
crashes the whole subtree. With no error boundary, the entire authenticated app
white-screens.

**Fix pattern:** for *non-critical / cosmetic* consumers (e.g. a notification-sound
side-effect), read contexts non-throwingly (`useContext` directly, or an
`...Optional()` variant) and fall back to safe defaults — never let a momentarily
missing provider take down the app. Keep the strict throwing hooks for genuine
misuse detection in critical code paths.

**Why:** the throw is correct for real misuse, but a cosmetic feature must degrade
gracefully, not escalate a transient dev-time desync into a full crash.

**How to apply:** when a "must be used within Provider" error fires from a
component you can see IS inside the provider, suspect HMR invalidation, not a
real hierarchy bug. Confirm by full reload (clean) + the `Could not Fast Refresh`
console lines. Harden the cosmetic consumer; optionally split Provider component
out of the hooks file and/or add an authenticated-shell error boundary.
