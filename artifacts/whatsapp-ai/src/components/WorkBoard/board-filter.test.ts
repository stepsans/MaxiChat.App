import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectBoardTags,
  matchesFilter,
  type BoardFilterState,
  type FilterableTask,
} from "./board-filter";

function task(assigneeIds: number[], tags: string | null): FilterableTask {
  return { assignees: assigneeIds.map((userId) => ({ userId })), tags };
}

function filter(p: Partial<BoardFilterState>): BoardFilterState {
  return { assigneeIds: [], tags: [], mode: "and", ...p };
}

// ── collectBoardTags ──────────────────────────────────────────────────────────
test("collectBoardTags: unique, case-insensitive, first-casing, sorted", () => {
  const tasks = [
    task([], "Urgent, client"),
    task([], "urgent,  Backend "),
    task([], null),
    task([], ""),
  ];
  assert.deepEqual(collectBoardTags(tasks), ["Backend", "client", "Urgent"]);
});

// ── No filter ─────────────────────────────────────────────────────────────────
test("empty filter matches every task", () => {
  assert.equal(matchesFilter(task([1], "x"), filter({})), true);
  assert.equal(matchesFilter(task([], null), filter({})), true);
});

// ── Assignee category (OR within) ─────────────────────────────────────────────
test("single assignee filter", () => {
  const f = filter({ assigneeIds: [1] });
  assert.equal(matchesFilter(task([1, 2], null), f), true);
  assert.equal(matchesFilter(task([3], null), f), false);
});

test("multi assignee is OR within category", () => {
  const f = filter({ assigneeIds: [1, 2] });
  assert.equal(matchesFilter(task([2], null), f), true); // has one of them
  assert.equal(matchesFilter(task([3, 4], null), f), false);
});

// ── Tag category (OR within, case-insensitive) ────────────────────────────────
test("tag filter is case-insensitive OR within category", () => {
  const f = filter({ tags: ["urgent", "client"] });
  assert.equal(matchesFilter(task([], "Urgent"), f), true);
  assert.equal(matchesFilter(task([], "CLIENT,backend"), f), true);
  assert.equal(matchesFilter(task([], "backend"), f), false);
});

test("task with no tags fails an active tag filter", () => {
  const f = filter({ tags: ["urgent"] });
  assert.equal(matchesFilter(task([1], null), f), false);
});

// ── Between-category mode ─────────────────────────────────────────────────────
test("mode AND requires both categories when both active", () => {
  const f = filter({ assigneeIds: [1], tags: ["urgent"], mode: "and" });
  assert.equal(matchesFilter(task([1], "urgent"), f), true); // both
  assert.equal(matchesFilter(task([1], "other"), f), false); // assignee only
  assert.equal(matchesFilter(task([9], "urgent"), f), false); // tag only
});

test("mode OR needs either category when both active", () => {
  const f = filter({ assigneeIds: [1], tags: ["urgent"], mode: "or" });
  assert.equal(matchesFilter(task([1], "other"), f), true); // assignee only
  assert.equal(matchesFilter(task([9], "urgent"), f), true); // tag only
  assert.equal(matchesFilter(task([9], "other"), f), false); // neither
});

test("mode is irrelevant when only one category active", () => {
  const tasks = [task([1], "urgent"), task([1], "x"), task([9], "urgent"), task([9], "x")];
  for (const t of tasks) {
    const a = matchesFilter(t, filter({ assigneeIds: [1], mode: "and" }));
    const o = matchesFilter(t, filter({ assigneeIds: [1], mode: "or" }));
    assert.equal(a, o, "assignee-only: and === or");
    const a2 = matchesFilter(t, filter({ tags: ["urgent"], mode: "and" }));
    const o2 = matchesFilter(t, filter({ tags: ["urgent"], mode: "or" }));
    assert.equal(a2, o2, "tag-only: and === or");
  }
});
