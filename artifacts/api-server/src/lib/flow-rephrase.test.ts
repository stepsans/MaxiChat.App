import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRephrasedText, FLOW_REPHRASE_SYSTEM_PROMPT } from "./flow-rephrase";

test("cleanRephrasedText trims whitespace", () => {
  assert.equal(cleanRephrasedText("  Mau pesan apa ya?  ", "fb"), "Mau pesan apa ya?");
});

test("cleanRephrasedText strips a single pair of wrapping quotes", () => {
  assert.equal(cleanRephrasedText('"Mau pesan apa?"', "fb"), "Mau pesan apa?");
  assert.equal(cleanRephrasedText("'Mau pesan apa?'", "fb"), "Mau pesan apa?");
  assert.equal(
    cleanRephrasedText("\u201CMau pesan apa?\u201D", "fb"),
    "Mau pesan apa?",
  );
});

test("cleanRephrasedText keeps inner quotes intact", () => {
  assert.equal(
    cleanRephrasedText('Kamu mau pesan "paket A" atau bukan?', "fb"),
    'Kamu mau pesan "paket A" atau bukan?',
  );
});

test("cleanRephrasedText falls back when empty/null/whitespace", () => {
  assert.equal(cleanRephrasedText(null, "fallback"), "fallback");
  assert.equal(cleanRephrasedText(undefined, "fallback"), "fallback");
  assert.equal(cleanRephrasedText("", "fallback"), "fallback");
  assert.equal(cleanRephrasedText("   ", "fallback"), "fallback");
  assert.equal(cleanRephrasedText('""', "fallback"), "fallback");
});

test("FLOW_REPHRASE_SYSTEM_PROMPT instructs paraphrase-not-answer", () => {
  assert.match(FLOW_REPHRASE_SYSTEM_PROMPT, /parafrase/i);
  assert.match(FLOW_REPHRASE_SYSTEM_PROMPT, /Jangan menjawab/i);
});
