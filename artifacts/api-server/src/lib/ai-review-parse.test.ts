import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonRows, toRowObjects, cellToString } from "./ai-review-parse";

describe("parseJsonRows", () => {
  it("parses a JSON array into one row per element (multi-item nota)", () => {
    const rows = parseJsonRows('[{"a":"1"},{"a":"2"},{"a":"3"}]');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], { a: "2" });
  });

  it("wraps a single top-level object into a one-row list (no line items)", () => {
    const rows = parseJsonRows('{"a":"1","b":"2"}');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { a: "1", b: "2" });
  });

  it("returns [] for an empty array", () => {
    assert.deepEqual(parseJsonRows("[]"), []);
  });

  it("returns [] for an array of non-objects", () => {
    assert.deepEqual(parseJsonRows('["x", 2, null, [1,2]]'), []);
  });

  it("drops non-object elements but keeps valid objects in a mixed array", () => {
    const rows = parseJsonRows('[{"a":"1"}, 5, "x", {"a":"2"}]');
    assert.deepEqual(rows, [{ a: "1" }, { a: "2" }]);
  });

  it("extracts a fenced array surrounded by prose", () => {
    const content = 'Berikut hasilnya:\n```json\n[{"a":"1"},{"a":"2"}]\n```\nselesai.';
    const rows = parseJsonRows(content);
    assert.equal(rows.length, 2);
  });

  it("extracts a fenced single object surrounded by prose", () => {
    const content = 'Hasil: ```json\n{"a":"1"}\n``` ok';
    const rows = parseJsonRows(content);
    assert.deepEqual(rows, [{ a: "1" }]);
  });

  it("returns [] for unparseable / empty content", () => {
    assert.deepEqual(parseJsonRows(""), []);
    assert.deepEqual(parseJsonRows("tidak ada JSON di sini"), []);
  });
});

describe("toRowObjects", () => {
  it("keeps only plain objects from an array", () => {
    assert.deepEqual(
      toRowObjects([{ a: 1 }, [1], "x", null, 3]),
      [{ a: 1 }]
    );
  });

  it("wraps a single object and rejects arrays/primitives", () => {
    assert.deepEqual(toRowObjects({ a: 1 }), [{ a: 1 }]);
    assert.deepEqual(toRowObjects(42), []);
    assert.deepEqual(toRowObjects(null), []);
  });
});

describe("cellToString", () => {
  it("renders null/undefined as empty string", () => {
    assert.equal(cellToString(null), "");
    assert.equal(cellToString(undefined), "");
  });

  it("passes strings through and stringifies numbers/booleans", () => {
    assert.equal(cellToString("abc"), "abc");
    assert.equal(cellToString(12000), "12000");
    assert.equal(cellToString(true), "true");
  });

  it("JSON-stringifies objects/arrays", () => {
    assert.equal(cellToString({ a: 1 }), '{"a":1}');
    assert.equal(cellToString([1, 2]), "[1,2]");
  });
});
