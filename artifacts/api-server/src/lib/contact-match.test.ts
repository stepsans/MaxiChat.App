import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchContactNames,
  normalizePhone,
  type ContactMatchRow,
} from "./contact-match";

describe("normalizePhone", () => {
  it("returns null for empty / undefined / no-digit input", () => {
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone("   "), null);
    assert.equal(normalizePhone("abc-xyz"), null);
  });

  it("returns null when there are too few digits to be a phone", () => {
    assert.equal(normalizePhone("12345"), null);
  });

  it("strips a single leading national trunk 0", () => {
    assert.deepEqual(normalizePhone("0812345678"), {
      digits: "812345678",
      matchKey: "812345678",
    });
  });

  it("strips non-digit characters (spaces, +, dashes)", () => {
    assert.deepEqual(normalizePhone("+62 812-345-678"), {
      digits: "62812345678",
      matchKey: "812345678",
    });
  });

  it("computes the match key from the last 9 digits", () => {
    const norm = normalizePhone("6281298765432");
    assert.equal(norm?.digits, "6281298765432");
    assert.equal(norm?.matchKey, "298765432");
  });
});

describe("matchContactNames suffix matching", () => {
  const contact = (
    phoneDigits: string,
    name: string
  ): ContactMatchRow => ({
    phoneDigits,
    matchKey: phoneDigits.slice(-9),
    name,
  });

  it("returns an empty map when there are no usable phones", () => {
    const rows = [contact("62812345678", "Budi")];
    assert.equal(matchContactNames(rows, []).size, 0);
    assert.equal(matchContactNames(rows, [null, undefined, "abc"]).size, 0);
  });

  it("matches the same contact across 08xx, 62-8xx and +62-8xx formats", () => {
    // Contact saved in 62-prefixed full form.
    const rows = [contact("62812345678", "Budi")];
    const inputs = ["0812345678", "62812345678", "+62 812-345-678"];
    const out = matchContactNames(rows, inputs);
    for (const input of inputs) {
      assert.equal(out.get(input), "Budi", `expected match for ${input}`);
    }
  });

  it("prefers an exact full-number hit over a suffix-only candidate", () => {
    // Two contacts collide on the same 9-digit suffix but differ in full digits.
    const rows = [
      contact("62812345678", "Budi (62)"),
      contact("0062812345678", "Budi (intl)"),
    ];
    // Exact full-number input must win against the colliding suffix.
    const out = matchContactNames(rows, ["62812345678"]);
    assert.equal(out.get("62812345678"), "Budi (62)");
  });

  it("refuses an ambiguous suffix-only match (two contacts share trailing digits)", () => {
    // Two DIFFERENT people whose numbers share the same 9-digit suffix.
    const rows = [
      contact("11812345678", "Andi"),
      contact("99812345678", "Citra"),
    ];
    // Input matches neither full number exactly, only the shared suffix.
    const out = matchContactNames(rows, ["62812345678"]);
    assert.equal(
      out.has("62812345678"),
      false,
      "must not guess a name across a suffix collision"
    );
  });

  it("uses an unambiguous suffix match when only one name shares the suffix", () => {
    const rows = [contact("11812345678", "Andi")];
    const out = matchContactNames(rows, ["62812345678"]);
    assert.equal(out.get("62812345678"), "Andi");
  });

  it("treats two rows with the same name on a shared suffix as unambiguous", () => {
    // Same person saved twice with different prefixes — still a single name.
    const rows = [
      contact("11812345678", "Andi"),
      contact("99812345678", "Andi"),
    ];
    const out = matchContactNames(rows, ["62812345678"]);
    assert.equal(out.get("62812345678"), "Andi");
  });
});
