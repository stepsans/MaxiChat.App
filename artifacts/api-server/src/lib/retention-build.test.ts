import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveRetentionDays,
  retentionCutoff,
  retentionCutoffs,
} from "./retention-build";

test("effective = min(chosen, cap), null = unlimited", () => {
  assert.equal(effectiveRetentionDays(30, 90), 30);
  assert.equal(effectiveRetentionDays(180, 90), 90); // clamped to cap
  assert.equal(effectiveRetentionDays(null, 90), 90);
  assert.equal(effectiveRetentionDays(30, null), 30);
  assert.equal(effectiveRetentionDays(null, null), null); // both unlimited
});

test("zero/negative treated as unlimited (never purge-all)", () => {
  assert.equal(effectiveRetentionDays(0, null), null);
  assert.equal(effectiveRetentionDays(-5, null), null);
});

test("cutoff is now - days; null retention → null cutoff", () => {
  const now = new Date(2026, 5, 1);
  const c = retentionCutoff(30, now);
  assert.ok(c);
  assert.equal(c.getTime(), now.getTime() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(retentionCutoff(null, now), null);
});

test("retentionCutoffs resolves per class against plan cap", () => {
  const now = new Date(2026, 5, 1);
  const cuts = retentionCutoffs(
    { chatDays: 30, mediaDays: 200, logDays: null, analyticsDays: 10 },
    90,
    now
  );
  assert.ok(cuts.chat); // 30
  assert.ok(cuts.media); // clamped to 90
  assert.ok(cuts.log); // capped at 90 (chosen unlimited)
  assert.ok(cuts.analytics); // 10
  // media clamped to 90 days, not 200
  assert.equal(cuts.media!.getTime(), now.getTime() - 90 * 24 * 60 * 60 * 1000);
});

test("both unlimited → null cutoff (skip class)", () => {
  const cuts = retentionCutoffs(
    { chatDays: null, mediaDays: null, logDays: null, analyticsDays: null },
    null,
    new Date()
  );
  assert.equal(cuts.chat, null);
  assert.equal(cuts.media, null);
});
