import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCategory,
  clampScore,
  deriveWaitingStatus,
  sanitizeEstimatedValue,
  buildTranscript,
  buildAnalysisSystemPrompt,
  parseInsight,
} from "./sales-insight-build";

describe("clampScore", () => {
  it("rounds and clamps to 0-100", () => {
    assert.equal(clampScore(50.4), 50);
    assert.equal(clampScore(50.6), 51);
    assert.equal(clampScore(-10), 0);
    assert.equal(clampScore(150), 100);
  });
  it("coerces strings and rejects non-finite", () => {
    assert.equal(clampScore("80"), 80);
    assert.equal(clampScore("abc"), 0);
    assert.equal(clampScore(NaN), 0);
    assert.equal(clampScore(null), 0);
    assert.equal(clampScore(undefined), 0);
  });
});

describe("scoreCategory", () => {
  it("maps boundaries 0-39 Low / 40-69 Medium / 70-100 High", () => {
    assert.equal(scoreCategory(0), "Low");
    assert.equal(scoreCategory(39), "Low");
    assert.equal(scoreCategory(40), "Medium");
    assert.equal(scoreCategory(69), "Medium");
    assert.equal(scoreCategory(70), "High");
    assert.equal(scoreCategory(100), "High");
  });
  it("clamps out-of-range input first", () => {
    assert.equal(scoreCategory(120), "High");
    assert.equal(scoreCategory(-5), "Low");
  });
});

describe("deriveWaitingStatus", () => {
  it("company sent last (outbound) -> waiting_customer", () => {
    assert.equal(deriveWaitingStatus("outbound"), "waiting_customer");
  });
  it("customer sent last (inbound) -> waiting_company", () => {
    assert.equal(deriveWaitingStatus("inbound"), "waiting_company");
  });
  it("no messages -> null", () => {
    assert.equal(deriveWaitingStatus(null), null);
    assert.equal(deriveWaitingStatus(undefined), null);
  });
});

describe("sanitizeEstimatedValue", () => {
  it("floors to whole Rupiah and rejects negatives/non-finite", () => {
    assert.equal(sanitizeEstimatedValue(1500000), 1500000);
    assert.equal(sanitizeEstimatedValue(1500000.9), 1500000);
    assert.equal(sanitizeEstimatedValue(-5), 0);
    assert.equal(sanitizeEstimatedValue("250000"), 250000);
    assert.equal(sanitizeEstimatedValue("abc"), 0);
    assert.equal(sanitizeEstimatedValue(NaN), 0);
  });
  it("always returns an integer", () => {
    assert.ok(Number.isInteger(sanitizeEstimatedValue(999.99)));
  });
});

describe("buildTranscript", () => {
  it("labels inbound Customer and outbound Company in order", () => {
    const t = buildTranscript([
      { direction: "inbound", content: "Halo, ada stok?" },
      { direction: "outbound", content: "Ada kak" },
    ]);
    assert.equal(t, "Customer: Halo, ada stok?\nCompany: Ada kak");
  });
  it("marks empty/media-only turns without inventing text", () => {
    const t = buildTranscript([{ direction: "inbound", content: "" }]);
    assert.equal(t, "Customer: [media/non-text message]");
  });
  it("treats unknown direction as Customer", () => {
    const t = buildTranscript([{ direction: "weird", content: "x" }]);
    assert.equal(t, "Customer: x");
  });
});

describe("buildAnalysisSystemPrompt", () => {
  it("embeds catalog and demands JSON-only output", () => {
    const p = buildAnalysisSystemPrompt("PROD-1 Kemeja 100000");
    assert.match(p, /PROD-1 Kemeja 100000/);
    assert.match(p, /HANYA dengan satu objek JSON/);
    // New multi-opportunity contract: the JSON shape is an `opportunities`
    // array whose items carry a snake_case `lead_score`.
    assert.match(p, /opportunities/);
    assert.match(p, /lead_score/);
  });
  it("falls back when catalog empty", () => {
    const p = buildAnalysisSystemPrompt("");
    assert.match(p, /Belum ada produk di katalog/);
  });
});

describe("parseInsight", () => {
  it("parses a clean JSON object", () => {
    const a = parseInsight(
      JSON.stringify({
        opportunities: [
          {
            intent_key: "prod-1-purchase",
            intent_type: "purchase",
            pipeline_type: "sales",
            lead_score: 85,
            intent_category: "hot",
            products: ["PROD-1", "Kemeja"],
            estimated_value_idr: 1500000,
            score_reason: "Tanya harga dan stok",
            ai_notes: "Mau beli 10pcs",
            recommendation: "Kirim penawaran",
          },
        ],
      })
    );
    assert.ok(a);
    assert.equal(a!.opportunities.length, 1);
    // Top-level fields aggregate from the highest-scored opportunity.
    assert.equal(a!.leadScore, 85);
    assert.equal(a!.intentCategory, "hot");
    assert.deepEqual(a!.productInterest, ["PROD-1", "Kemeja"]);
    assert.equal(a!.estimatedValueIdr, 1500000);
  });

  it("aggregates top-level fields from the highest-scored opportunity", () => {
    const a = parseInsight(
      JSON.stringify({
        opportunities: [
          { intent_key: "a", lead_score: 40, products: ["A"], intent_category: "warm" },
          { intent_key: "b", lead_score: 90, products: ["B", "A"], intent_category: "hot", estimated_value_idr: 2000000 },
        ],
      })
    );
    assert.ok(a);
    assert.equal(a!.opportunities.length, 2);
    assert.equal(a!.leadScore, 90);
    assert.equal(a!.intentCategory, "hot");
    assert.equal(a!.estimatedValueIdr, 2000000);
    // productInterest is the de-duplicated union across all opportunities.
    assert.deepEqual(a!.productInterest, ["A", "B"]);
  });

  it("extracts JSON wrapped in prose / code fences", () => {
    const a = parseInsight(
      'Berikut hasilnya:\n```json\n{"opportunities":[{"intent_key":"x","lead_score":42,"estimated_value_idr":200000}]}\n```\nselesai'
    );
    assert.ok(a);
    assert.equal(a!.leadScore, 42);
    assert.equal(a!.estimatedValueIdr, 200000);
  });

  it("clamps score and floors money from the model", () => {
    const a = parseInsight(
      '{"opportunities":[{"intent_key":"x","lead_score":150,"estimated_value_idr":999.9}]}'
    );
    assert.ok(a);
    assert.equal(a!.leadScore, 100);
    assert.equal(a!.estimatedValueIdr, 999);
  });

  it("defaults missing fields safely", () => {
    const a = parseInsight("{}");
    assert.ok(a);
    assert.deepEqual(a!.opportunities, []);
    assert.equal(a!.leadScore, 0);
    assert.equal(a!.intentCategory, null);
    assert.deepEqual(a!.productInterest, []);
    assert.equal(a!.estimatedValueIdr, 0);
    assert.equal(a!.recommendation, null);
  });

  it("drops candidates without an intent_key", () => {
    // intent_key is required — a candidate missing it is discarded entirely.
    const a = parseInsight(
      '{"opportunities":[{"lead_score":80,"products":["A"]},{"intent_key":"keep","lead_score":50}]}'
    );
    assert.ok(a);
    assert.equal(a!.opportunities.length, 1);
    assert.equal(a!.opportunities[0]!.intentKey, "keep");
  });

  it("drops non-string entries from a candidate's products", () => {
    const a = parseInsight(
      '{"opportunities":[{"intent_key":"x","products":["A", 5, null, "B", ""]}]}'
    );
    assert.deepEqual(a!.productInterest, ["A", "B"]);
  });

  it("returns null when no JSON object can be recovered (explicit failure)", () => {
    assert.equal(parseInsight(""), null);
    assert.equal(parseInsight("tidak ada json di sini"), null);
    assert.equal(parseInsight("[1,2,3]"), null);
  });
});
