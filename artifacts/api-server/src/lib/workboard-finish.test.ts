import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIsCompleted } from "./workboard-finish";

test("finish stage true → completed", () => {
  assert.equal(deriveIsCompleted(true), true);
});

test("finish stage false → not completed", () => {
  assert.equal(deriveIsCompleted(false), false);
});

test("no column (null) → not completed", () => {
  assert.equal(deriveIsCompleted(null), false);
});

test("no column (undefined) → not completed", () => {
  assert.equal(deriveIsCompleted(undefined), false);
});
