---
name: Fetch interceptor ref ordering
description: When a React fetch interceptor reads from a ref and the same code path that mutates the ref also triggers refetches, the ref MUST be assigned before the refetch fires — not by relying on the next render.
---

# Rule

When a global fetch interceptor (orval mutator, axios interceptor, custom `customFetch`) reads its value from a `useRef` that is kept in sync with React state, **every mutator that triggers a refetch must update the ref imperatively before triggering the refetch**. Do not rely on the "assign ref on render" pattern.

```ts
// WRONG — interceptor still sees the OLD header during invalidation
const activeRef = useRef(state);
activeRef.current = state; // runs on render — AFTER invalidation has already fired

function setActive(next) {
  setState(next);
  queryClient.invalidateQueries(); // <-- refetches with stale ref
}
```

```ts
// RIGHT — ref is correct at the moment the refetch lands
const activeRef = useRef(state);
// no `activeRef.current = state` at the top level

function setActive(next) {
  activeRef.current = next;        // 1. ref first
  persist(next);                   // 2. side-effects that should see "next"
  queryClient.invalidateQueries(); // 3. refetches now see the new ref
  setState(next);                  // 4. React state last (UI catches up)
}
```

**Why:** React refs assigned at the top level of a function component only update after commit. `queryClient.invalidateQueries()` runs synchronously inside the event handler — well before commit — so the interceptor invoked by the resulting refetches will read the *previous* ref value. Result: first request after the switch carries the old header, returns old-tenant data, races against the UI thinking it switched.

**How to apply:** Channel/tenant/locale switchers, auth-token rotation handlers, any header-injecting interceptor whose value the user toggles in-session. Centralise the mutation in one helper (`switchTo`) so every code path — explicit setter, auto-fallback effect, deep-link handler — goes through the correct order: **ref → persist → invalidate → setState**.

**Bonus:** Scope `invalidateQueries({ predicate })` to exclude static-per-user surfaces (`/auth/me`, the switcher's own list endpoint, permissions) so frequent switching doesn't thrash unaffected queries.
