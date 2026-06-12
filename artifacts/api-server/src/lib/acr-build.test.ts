import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateAgentScores,
  allowanceFor,
  capTranscriptMessages,
  computeNextRunAt,
  computeRedFlagImpacts,
  computeResponseMetrics,
  defaultConversationAiResult,
  gradeFor,
  missedChatToRawScore,
  normalizeConversationAiResult,
  parseAiJson,
  periodToUtcRange,
  responseTimeToRawScore,
  validateConfigInput,
  type AcrConfigSnapshot,
  type AcrMessage,
} from "./acr-build";

const cfg: AcrConfigSnapshot = {
  weightResponseTime: 25,
  weightLanguageQuality: 25,
  weightAnswerQuality: 25,
  weightComplaintHandling: 15,
  weightMissedChat: 10,
  slaExcellentMinutes: 3,
  slaGoodMinutes: 5,
  slaAcceptableMinutes: 15,
  slaPoorMinutes: 30,
  slaCriticalMinutes: 60,
  gradeAThreshold: 90,
  gradeBThreshold: 75,
  gradeCThreshold: 60,
  gradeDThreshold: 45,
  allowanceGradeA: 1_000_000,
  allowanceGradeB: 500_000,
  allowanceGradeC: 250_000,
  allowanceGradeD: 100_000,
  allowanceGradeE: 0,
  complaintHandlingEnabled: true,
};

const t0 = new Date("2025-06-24T03:00:00Z"); // 10:00 WIB
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * 60_000);

let nextId = 1;
function msg(
  direction: "inbound" | "outbound",
  minutes: number,
  opts: { ai?: boolean; content?: string } = {}
): AcrMessage {
  return {
    id: nextId++,
    direction,
    isAiGenerated: opts.ai ?? false,
    content: opts.content ?? "halo",
    createdAt: at(minutes),
  };
}

describe("validateConfigInput", () => {
  it("accepts the spec defaults", () => {
    assert.equal(validateConfigInput(cfg), null);
  });
  it("rejects weights not summing to 100", () => {
    assert.match(
      validateConfigInput({ ...cfg, weightMissedChat: 11 })!,
      /Total bobot harus 100/
    );
  });
  it("rejects non-ascending SLA", () => {
    assert.ok(validateConfigInput({ ...cfg, slaGoodMinutes: 3 }));
  });
  it("rejects non-descending grades", () => {
    assert.ok(validateConfigInput({ ...cfg, gradeBThreshold: 90 }));
  });
  it("rejects decimal allowances (whole Rupiah only)", () => {
    assert.ok(validateConfigInput({ ...cfg, allowanceGradeA: 1000.5 }));
  });
});

describe("computeResponseMetrics", () => {
  it("measures from the FIRST inbound of a customer turn", () => {
    const m = computeResponseMetrics(
      [msg("inbound", 0), msg("inbound", 35), msg("outbound", 60)],
      60
    );
    assert.equal(m.responseTimesMinutes.length, 1);
    assert.equal(m.responseTimesMinutes[0], 60);
    assert.equal(m.missedTurns, 0);
    // 2 inbound before the reply → customer_ignored.
    assert.equal(m.customerIgnoredEvents.length, 1);
    assert.equal(m.customerIgnoredEvents[0]!.repeatCount, 2);
  });

  it("counts an unanswered turn as missed", () => {
    const m = computeResponseMetrics(
      [msg("inbound", 0), msg("outbound", 2), msg("inbound", 10)],
      60
    );
    assert.equal(m.missedTurns, 1);
    assert.equal(m.responseTimesMinutes.length, 1);
    assert.equal(m.responseTimesMinutes[0], 2);
  });

  it("AI replies close a turn without crediting human response time", () => {
    const m = computeResponseMetrics(
      [msg("inbound", 0), msg("outbound", 1, { ai: true })],
      60
    );
    assert.equal(m.missedTurns, 0);
    assert.equal(m.responseTimesMinutes.length, 0);
    assert.equal(m.totalAgentMessages, 0);
  });

  it("flags responses beyond the critical SLA", () => {
    const m = computeResponseMetrics([msg("inbound", 0), msg("outbound", 90)], 60);
    assert.equal(m.noReplyCriticalEvents.length, 1);
    assert.equal(Math.round(m.noReplyCriticalEvents[0]!.minutes), 90);
  });
});

describe("score conversion", () => {
  it("maps avg response time to the SLA bands", () => {
    assert.equal(responseTimeToRawScore(2, cfg), 100);
    assert.equal(responseTimeToRawScore(4, cfg), 85);
    assert.equal(responseTimeToRawScore(10, cfg), 65);
    assert.equal(responseTimeToRawScore(25, cfg), 40);
    assert.equal(responseTimeToRawScore(50, cfg), 15);
    assert.equal(responseTimeToRawScore(120, cfg), 0);
    assert.equal(responseTimeToRawScore(null, cfg), 100);
  });

  it("maps missed percentage to score bands", () => {
    assert.equal(missedChatToRawScore(0, 100), 100);
    assert.equal(missedChatToRawScore(5, 100), 75);
    assert.equal(missedChatToRawScore(10, 100), 50);
    assert.equal(missedChatToRawScore(20, 100), 25);
    assert.equal(missedChatToRawScore(30, 100), 0);
    assert.equal(missedChatToRawScore(0, 0), 100);
  });
});

describe("aggregateAgentScores", () => {
  it("weights dimensions and sums (complaint default 85 when none)", () => {
    const r = aggregateAgentScores(
      {
        rawResponseTimeScore: 100,
        rawMissedChatScore: 100,
        rawLanguageScore: 80,
        rawAnswerScore: 80,
        rawComplaintScore: null,
      },
      cfg
    );
    assert.equal(r.scoreResponseTime, 25);
    assert.equal(r.scoreLanguageQuality, 20);
    assert.equal(r.scoreAnswerQuality, 20);
    assert.equal(r.scoreComplaintHandling, 12.75); // 85 × 15%
    assert.equal(r.scoreMissedChat, 10);
    assert.equal(r.totalScore, 87.75);
  });

  it("redistributes complaint weight proportionally when disabled", () => {
    const r = aggregateAgentScores(
      {
        rawResponseTimeScore: 100,
        rawMissedChatScore: 100,
        rawLanguageScore: 100,
        rawAnswerScore: 100,
        rawComplaintScore: 50,
      },
      { ...cfg, complaintHandlingEnabled: false }
    );
    assert.equal(r.scoreComplaintHandling, 0);
    // All other dimensions perfect → total must still reach 100.
    assert.equal(r.totalScore, 100);
  });
});

describe("grade & allowance", () => {
  it("maps thresholds to grades", () => {
    assert.equal(gradeFor(95, cfg), "A");
    assert.equal(gradeFor(90, cfg), "A");
    assert.equal(gradeFor(89.99, cfg), "B");
    assert.equal(gradeFor(60, cfg), "C");
    assert.equal(gradeFor(45, cfg), "D");
    assert.equal(gradeFor(44.99, cfg), "E");
  });
  it("resolves allowance from the snapshot", () => {
    assert.equal(allowanceFor("A", cfg), 1_000_000);
    assert.equal(allowanceFor("E", cfg), 0);
  });
});

describe("transcript capping", () => {
  it("keeps all messages when <= 50", () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    assert.equal(capTranscriptMessages(arr).length, 50);
  });
  it("keeps 10 first + 40 last when longer", () => {
    const arr = Array.from({ length: 120 }, (_, i) => i);
    const capped = capTranscriptMessages(arr);
    assert.equal(capped.length, 50);
    assert.equal(capped[0], 0);
    assert.equal(capped[9], 9);
    assert.equal(capped[10], 80);
    assert.equal(capped[49], 119);
  });
});

describe("periodToUtcRange", () => {
  it("covers full WIB days", () => {
    const { start, end } = periodToUtcRange("2025-05-13", "2025-06-12");
    assert.equal(start.toISOString(), "2025-05-12T17:00:00.000Z");
    assert.equal(end.toISOString(), "2025-06-12T16:59:59.999Z");
  });
});

describe("AI JSON parsing", () => {
  it("parses plain and fenced JSON", () => {
    assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseAiJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.equal(parseAiJson("not json"), null);
  });

  it("normalizes and clamps a conversation result", () => {
    const r = normalizeConversationAiResult({
      language_quality_score: 250,
      answer_quality_score: -5,
      complaint_handling_score: 60,
      has_complaint: true,
      complaint_resolved: true,
      red_flags: [
        { type: "customer_angry", severity: "critical", explanation: "x" },
        { type: "invalid_type", severity: "high", explanation: "y" },
      ],
      ai_notes: "ok",
    });
    assert.equal(r.language_quality_score, 100);
    assert.equal(r.answer_quality_score, 0);
    assert.equal(r.red_flags.length, 1);
    assert.equal(r.red_flags[0]!.type, "customer_angry");
    assert.equal(r.complaint_resolved, true);
  });

  it("complaint_resolved is forced false without a complaint", () => {
    const r = normalizeConversationAiResult({
      has_complaint: false,
      complaint_resolved: true,
      red_flags: [],
    });
    assert.equal(r.complaint_resolved, false);
  });

  it("default fallback matches the spec", () => {
    const d = defaultConversationAiResult();
    assert.equal(d.language_quality_score, 70);
    assert.equal(d.complaint_handling_score, 85);
    assert.equal(d.red_flags.length, 0);
  });
});

describe("computeRedFlagImpacts", () => {
  it("splits a dimension's lost points across its flags", () => {
    const weighted = aggregateAgentScores(
      {
        rawResponseTimeScore: 40, // lost 15 of 25
        rawMissedChatScore: 100,
        rawLanguageScore: 100,
        rawAnswerScore: 100,
        rawComplaintScore: 100,
      },
      cfg
    );
    const impacts = computeRedFlagImpacts(
      [{ violationType: "no_reply_critical" }, { violationType: "customer_ignored" }],
      weighted,
      cfg
    );
    assert.equal(impacts[0]!.dimension, "response_time");
    assert.equal(impacts[0]!.points + impacts[1]!.points, 15);
  });
});

describe("computeNextRunAt", () => {
  // 2026-06-12 is a Friday.
  const now = new Date("2026-06-12T04:00:00Z"); // 11:00 WIB Friday

  it("monthly: next occurrence of the day-of-month at 06:00 WIB", () => {
    const next = computeNextRunAt(
      { frequency: "monthly", dayOfMonth: 1, dayOfWeek: 1, everyDays: 30 },
      now
    );
    assert.equal(next.toISOString(), "2026-06-30T23:00:00.000Z"); // Jul 1, 06:00 WIB
  });

  it("weekly: next Monday at 06:00 WIB", () => {
    const next = computeNextRunAt(
      { frequency: "weekly", dayOfMonth: 1, dayOfWeek: 1, everyDays: 30 },
      now
    );
    assert.equal(next.toISOString(), "2026-06-14T23:00:00.000Z"); // Mon Jun 15, 06:00 WIB
  });

  it("custom: N days ahead", () => {
    const next = computeNextRunAt(
      { frequency: "custom", dayOfMonth: 1, dayOfWeek: 1, everyDays: 10 },
      now
    );
    assert.equal(next.toISOString(), "2026-06-21T23:00:00.000Z"); // Jun 22, 06:00 WIB
  });

  it("is always strictly in the future", () => {
    const next = computeNextRunAt(
      { frequency: "monthly", dayOfMonth: 12, dayOfWeek: 1, everyDays: 30 },
      now // it IS the 12th, 11:00 WIB — after 06:00, so next month
    );
    assert.ok(next.getTime() > now.getTime());
    assert.equal(next.toISOString(), "2026-07-11T23:00:00.000Z");
  });
});
