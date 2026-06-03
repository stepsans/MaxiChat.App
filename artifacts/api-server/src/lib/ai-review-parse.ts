// Pure (db-free) parsing helpers for AI Review model output, kept in their own
// module so they can be unit-tested without importing the database layer.

// Normalise any parsed JSON value into a list of row objects. A top-level array
// becomes one row per element; a single object becomes a one-row list; anything
// else (or nested non-objects) is dropped.
export function toRowObjects(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) {
    return v.filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x === "object" && !Array.isArray(x)
    );
  }
  if (v && typeof v === "object") return [v as Record<string, unknown>];
  return [];
}

// Models sometimes wrap JSON in ``` fences or prose. Parse defensively into the
// list of row objects: one nota can yield several rows (one per line item), so
// we accept a JSON array (preferred), a single object (one row), and fall back
// to substring extraction so a stray character doesn't drop a whole receipt.
export function parseJsonRows(content: string): Record<string, unknown>[] {
  const trimmed = content.trim();
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(trimmed);
  if (parsed === undefined) {
    // Try the outermost array first, then the outermost object.
    const as = trimmed.indexOf("[");
    const ae = trimmed.lastIndexOf("]");
    if (as >= 0 && ae > as) parsed = tryParse(trimmed.slice(as, ae + 1));
    if (parsed === undefined) {
      const os = trimmed.indexOf("{");
      const oe = trimmed.lastIndexOf("}");
      if (os >= 0 && oe > os) parsed = tryParse(trimmed.slice(os, oe + 1));
    }
  }
  return toRowObjects(parsed);
}

export function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
