import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AiReviewColumn } from "@workspace/db";
import { buildAiReviewSystemPrompt } from "./ai-review-prompt";

const COLUMNS: AiReviewColumn[] = [
  { name: "Tanggal", hint: "Tanggal pada nota" },
  { name: "Total" },
];

describe("buildAiReviewSystemPrompt", () => {
  it("uses the default receipt-OCR task when prompt is null/empty/whitespace", () => {
    const fromNull = buildAiReviewSystemPrompt(null, COLUMNS);
    const fromUndefined = buildAiReviewSystemPrompt(undefined, COLUMNS);
    const fromEmpty = buildAiReviewSystemPrompt("", COLUMNS);
    const fromBlank = buildAiReviewSystemPrompt("   \n  ", COLUMNS);
    for (const p of [fromNull, fromUndefined, fromEmpty, fromBlank]) {
      assert.match(p, /asisten OCR untuk merekap nota\/struk/);
    }
    // null and whitespace-only collapse to the identical default prompt.
    assert.equal(fromNull, fromUndefined);
    assert.equal(fromNull, fromEmpty);
    assert.equal(fromNull, fromBlank);
  });

  it("uses a non-empty custom prompt as the task instruction", () => {
    const custom = "Baca daftar pesanan pelanggan dan ekstrak nama serta jumlah.";
    const p = buildAiReviewSystemPrompt(custom, COLUMNS);
    assert.match(p, /Baca daftar pesanan pelanggan/);
    // The default receipt task must NOT leak in when a custom prompt is set.
    assert.doesNotMatch(p, /asisten OCR untuk merekap nota\/struk/);
  });

  it("trims surrounding whitespace from a custom prompt", () => {
    const p = buildAiReviewSystemPrompt("  Lakukan X.  ", COLUMNS);
    // Trimmed task sits at the very start, immediately followed by the blank
    // line before the output contract (no leftover leading/trailing spaces).
    assert.ok(p.startsWith("Lakukan X.\n\n"));
  });

  it("always enforces the JSON-keyed-by-column output contract", () => {
    for (const prompt of [null, "Custom task instruction."]) {
      const p = buildAiReviewSystemPrompt(prompt, COLUMNS);
      assert.match(p, /Balas HANYA dengan satu objek JSON/);
      assert.match(p, /Gunakan nama kolom persis sebagai key JSON/);
    }
  });

  it("lists every configured column (with hint when present) under KOLOM", () => {
    const p = buildAiReviewSystemPrompt(null, COLUMNS);
    assert.match(p, /KOLOM:/);
    assert.match(p, /1\. "Tanggal" — Tanggal pada nota/);
    assert.match(p, /2\. "Total"/);
  });
});
