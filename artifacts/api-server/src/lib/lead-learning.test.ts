import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideReviewTrigger,
  aiSuggestedStatusOf,
  buildLessonsBlock,
} from "./lead-learning";

describe("aiSuggestedStatusOf", () => {
  it("skipped (reverse-role/not_lead) leans not_lead", () => {
    assert.equal(
      aiSuggestedStatusOf({ skipped: true, leadClassification: "unclear", score: 0, scoreThreshold: 60 }),
      "not_lead"
    );
  });
  it("score >= threshold leans lead", () => {
    assert.equal(
      aiSuggestedStatusOf({ skipped: false, leadClassification: "unclear", score: 70, scoreThreshold: 60 }),
      "lead"
    );
  });
  it("low score, no lead classification leans not_lead", () => {
    assert.equal(
      aiSuggestedStatusOf({ skipped: false, leadClassification: "unclear", score: 20, scoreThreshold: 60 }),
      "not_lead"
    );
  });
});

describe("decideReviewTrigger", () => {
  const base = {
    contactName: "Budi",
    scoreThreshold: 60,
    conversationRole: "tenant_is_seller",
    skipped: false,
    leadClassification: "lead",
    manual: null,
  };

  it("flags a conflict when AI wants not_lead but human marked lead", () => {
    const d = decideReviewTrigger({
      ...base,
      skipped: true,
      leadClassification: "not_lead",
      score: 0,
      manual: { leadStatus: "lead", leadClassifiedBy: "manual" },
    });
    assert.equal(d.trigger, "conflict");
    assert.equal(d.aiSuggestedStatus, "not_lead");
    assert.match(d.question ?? "", /Budi/);
  });

  it("flags a conflict when AI wants lead but human marked not_lead", () => {
    const d = decideReviewTrigger({
      ...base,
      score: 85,
      manual: { leadStatus: "not_lead", leadClassifiedBy: "manual" },
    });
    assert.equal(d.trigger, "conflict");
    assert.equal(d.aiSuggestedStatus, "lead");
  });

  it("an AI-classified label is NOT authoritative — no conflict against it", () => {
    const d = decideReviewTrigger({
      ...base,
      score: 85,
      manual: { leadStatus: "not_lead", leadClassifiedBy: "ai" },
    });
    assert.equal(d.trigger, null);
  });

  it("flags uncertain when score sits on the threshold band", () => {
    const d = decideReviewTrigger({ ...base, leadClassification: "unclear", score: 62 });
    assert.equal(d.trigger, "uncertain");
  });

  it("flags uncertain when role is unclear on a non-skipped chat", () => {
    const d = decideReviewTrigger({
      ...base,
      conversationRole: "unclear",
      leadClassification: "unclear",
      score: 30,
    });
    assert.equal(d.trigger, "uncertain");
  });

  it("a confident, non-borderline lead with no manual label needs no review", () => {
    const d = decideReviewTrigger({ ...base, score: 90 });
    assert.equal(d.needsReview, false);
    assert.equal(d.trigger, null);
  });

  it("a clearly skipped reverse-role chat with no manual label needs no review", () => {
    const d = decideReviewTrigger({
      ...base,
      skipped: true,
      leadClassification: "not_lead",
      conversationRole: "tenant_is_buyer",
      score: 0,
    });
    assert.equal(d.needsReview, false);
  });
});

describe("buildLessonsBlock", () => {
  it("returns empty string when there is nothing to teach", () => {
    assert.equal(buildLessonsBlock([]), "");
    assert.equal(
      buildLessonsBlock([{ fromStatus: "unknown", toStatus: "lead", reason: "  ", contextSummary: null }]),
      ""
    );
  });

  it("renders one line per useful correction with the corrected verdict", () => {
    const block = buildLessonsBlock([
      {
        fromStatus: "lead",
        toStatus: "not_lead",
        reason: "saya yang beli dari mereka",
        contextSummary: "pesan martabak",
        aiConversationRole: "tenant_is_buyer",
      },
      {
        fromStatus: "unknown",
        toStatus: "lead",
        reason: "serius tanya harga borongan",
        contextSummary: null,
      },
    ]);
    assert.match(block, /PELAJARAN DARI TENANT/);
    assert.match(block, /\[not lead\] "saya yang beli dari mereka"/);
    assert.match(block, /konteks: pesan martabak/);
    assert.match(block, /\[lead\] "serius tanya harga borongan"/);
  });

  it("caps the number of lessons", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      fromStatus: "unknown",
      toStatus: "lead",
      reason: `alasan ${i}`,
    }));
    const block = buildLessonsBlock(rows, 5);
    const count = (block.match(/^- /gm) ?? []).length;
    assert.equal(count, 5);
  });
});
