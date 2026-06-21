// Pure, dependency-free filter logic for WorkBoard views (spec §7). Kept free of
// React / "@/" aliases so it can be unit-tested directly with node:test + tsx.
//
// Rules:
// - Within each category (assignee / tag): always OR.
// - Between categories (assignee vs tag): controlled by `mode` ("and" | "or").
// - Empty filter (nothing selected) → matches everything.
// - When only ONE category is active, `mode` is irrelevant (the single active
//   criterion is returned as-is).

// Minimal structural shape the matcher needs; WorkboardTask satisfies it.
export interface FilterableTask {
  assignees: { userId: number }[];
  tags: string | null;
}

export interface BoardFilterState {
  assigneeIds: number[]; // empty = no assignee filter
  tags: string[]; // empty = no tag filter (stored lowercase)
  mode: "and" | "or"; // relationship BETWEEN categories; default "and"
}

export const EMPTY_FILTER: BoardFilterState = { assigneeIds: [], tags: [], mode: "and" };

// Unique tags across the board, keyed case-insensitively but displayed using the
// first-seen original casing, sorted alphabetically.
export function collectBoardTags(tasks: FilterableTask[]): string[] {
  const set = new Map<string, string>(); // lowercase -> first-seen original casing
  for (const t of tasks) {
    if (!t.tags) continue;
    for (const raw of t.tags.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!set.has(key)) set.set(key, trimmed);
    }
  }
  return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
}

// True if the task should be shown given the active filters.
export function matchesFilter(task: FilterableTask, f: BoardFilterState): boolean {
  const hasAssigneeFilter = f.assigneeIds.length > 0;
  const hasTagFilter = f.tags.length > 0;

  // No active filter → show everything.
  if (!hasAssigneeFilter && !hasTagFilter) return true;

  // Assignee criterion (OR within: any of the task's assignees in the set).
  const assigneeMatch = hasAssigneeFilter
    ? (() => {
        const ids = new Set(f.assigneeIds);
        return task.assignees.some((a) => ids.has(a.userId));
      })()
    : null;

  // Tag criterion (OR within: any of the task's tags in the set), case-insensitive.
  const tagMatch = hasTagFilter
    ? (() => {
        const wanted = new Set(f.tags.map((t) => t.toLowerCase()));
        const taskTags = (task.tags ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        return taskTags.some((t) => wanted.has(t));
      })()
    : null;

  // Only ACTIVE criteria contribute. With one active criterion, every()/some()
  // reduce to that single value → mode is irrelevant.
  const active: boolean[] = [];
  if (assigneeMatch !== null) active.push(assigneeMatch);
  if (tagMatch !== null) active.push(tagMatch);

  return f.mode === "and" ? active.every(Boolean) : active.some(Boolean);
}

// How many filter categories are currently active (0, 1, or 2). The mode toggle
// only matters when this is 2.
export function activeCategoryCount(f: BoardFilterState): number {
  return (f.assigneeIds.length > 0 ? 1 : 0) + (f.tags.length > 0 ? 1 : 0);
}

export function isFilterActive(f: BoardFilterState): boolean {
  return activeCategoryCount(f) > 0;
}
