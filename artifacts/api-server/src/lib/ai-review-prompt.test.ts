import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AiReviewColumn } from "@workspace/db";
import { buildAiReviewSystemPrompt } from "./ai-review-prompt";

const COLUMNS: AiReviewColumn[] = [
  { name: "Tanggal", hint: "Tanggal pada nota" },
  { name: "Total" },
];

describe("buildAiReviewSystemPrompt", () => {
  it("throws when the prompt is empty/whitespace (instruction is required)", () => {
    assert.throws(() => buildAiReviewSystemPrompt("", COLUMNS));
    assert.throws(() => buildAiReviewSystemPrompt("   \n  ", COLUMNS));
  });

  it("uses the per-group prompt as the task instruction", () => {
    const custom = "Baca daftar pesanan pelanggan dan ekstrak nama serta jumlah.";
    const p = buildAiReviewSystemPrompt(custom, COLUMNS);
    assert.match(p, /Baca daftar pesanan pelanggan/);
  });

  it("trims surrounding whitespace from the prompt", () => {
    const p = buildAiReviewSystemPrompt("  Lakukan X.  ", COLUMNS);
    // Trimmed task sits at the very start, immediately followed by the blank
    // line before the output contract (no leftover leading/trailing spaces).
    assert.ok(p.startsWith("Lakukan X.\n\n"));
  });

  it("always enforces the JSON-keyed-by-column output contract", () => {
    const p = buildAiReviewSystemPrompt("Custom task instruction.", COLUMNS);
    assert.match(p, /Balas HANYA dengan JSON array berisi objek/);
    assert.match(p, /Gunakan nama kolom persis sebagai key JSON/);
  });

  it("instructs one object per line item (multi-row per nota)", () => {
    const p = buildAiReviewSystemPrompt("Custom task.", COLUMNS);
    assert.match(p, /SATU baris\/item/);
    assert.match(p, /balas array berisi satu objek/);
  });

  it("lists every configured column (with hint when present) under KOLOM", () => {
    const p = buildAiReviewSystemPrompt("Custom task.", COLUMNS);
    assert.match(p, /KOLOM:/);
    assert.match(p, /1\. "Tanggal" — Tanggal pada nota/);
    assert.match(p, /2\. "Total"/);
  });
});
