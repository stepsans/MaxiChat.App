---
name: drizzle sql tag spreads JS arrays
description: drizzle-orm's `sql` template tag interpolates JS arrays as SQL tuples `($1,$2,...)`, not as PG array literals — fatal for `text[]`/`int[]` columns.
---

When using drizzle-orm's `sql` template tag with a raw `text[]` (or any PG array) column, do NOT interpolate a JS array directly:

```ts
// BROKEN: produces `COALESCE(col, ($1, $2, $3))` → "COALESCE types text[] and record cannot be matched"
// or with 1 element: `COALESCE(col, ($1))` with a scalar → "malformed array literal"
sql`COALESCE(${col}, ${jsArray})`
```

Build an explicit `ARRAY[...]::text[]` literal with `sql.join`:

```ts
const arr = sql`ARRAY[${sql.join(jsArray.map(v => sql`${v}`), sql`, `)}]::text[]`;
sql`COALESCE(${col}, ${arr})`
```

**Why:** The `sql` tag's array-spreading behavior is fine for `IN (...)` clauses but silently wrong for array-typed columns. Single-element arrays are the most insidious — they collapse to `($1)` with a scalar param, and Postgres reports "malformed array literal: <scalar>" with no hint that drizzle stripped the array wrapper.

**How to apply:** Any time you write `sql\`...\`` that targets a column declared with `.array()` in the schema, build the value via `ARRAY[...]::T[]` + `sql.join`, never bare interpolation. Normal `.values()` / `.set({col: jsArray})` paths are safe — drizzle binds them as a single param. The bug only appears in raw `sql` template usage (typically COALESCE / CASE / computed-update expressions).
