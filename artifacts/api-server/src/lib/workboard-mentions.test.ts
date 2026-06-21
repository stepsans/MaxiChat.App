import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentionIds } from "./workboard-mentions";

test("no mentions → empty", () => {
  assert.deepEqual(parseMentionIds("halo tim, tolong cek task ini"), []);
});

test("single mention", () => {
  assert.deepEqual(parseMentionIds("cc @[42] tolong ya"), [42]);
});

test("multiple mentions in order", () => {
  assert.deepEqual(parseMentionIds("@[7] dan @[3] cek ini @[12]"), [7, 3, 12]);
});

test("duplicate mentions are deduped, first-appearance order kept", () => {
  assert.deepEqual(parseMentionIds("@[5] @[9] @[5] @[9]"), [5, 9]);
});

test("malformed token @[abc] is ignored", () => {
  assert.deepEqual(parseMentionIds("@[abc] @[10] @[]"), [10]);
});

test("plain @name is NOT a mention", () => {
  assert.deepEqual(parseMentionIds("@budi @siti tolong"), []);
});

test("token embedded in text still parses", () => {
  assert.deepEqual(parseMentionIds("Halo@[8]!periksa@[8]lagi"), [8]);
});
