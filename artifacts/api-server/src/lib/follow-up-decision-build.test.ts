import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideFollowUp,
  MAX_FOLLOW_UPS,
  type FollowUpDecisionInput,
} from "./follow-up-decision-build";

const HOUR = 60 * 60 * 1000;

function base(overrides: Partial<FollowUpDecisionInput> = {}): FollowUpDecisionInput {
  return {
    status: "open",
    waitingStatus: "waiting_customer",
    sentCount: 0,
    stopRequested: false,
    hasOpenTask: false,
    lastMeaningfulAt: new Date("2026-03-01T00:00:00Z"),
    lastFollowUpAt: null,
    intervalHours: 48,
    now: new Date("2026-03-03T01:00:00Z"), // 49h after anchor → due
    ...overrides,
  };
}

test("due when waiting_customer, open, under cap, and interval elapsed", () => {
  const d = decideFollowUp(base());
  assert.equal(d.due, true);
  if (d.due) {
    assert.equal(d.reason, "due");
    assert.equal(d.nextSequence, 1);
    assert.deepEqual(d.dueAt, new Date("2026-03-03T00:00:00Z"));
  }
});

test("terminal status (won/lost) never due", () => {
  assert.equal(decideFollowUp(base({ status: "won" })).reason, "terminal_status");
  assert.equal(decideFollowUp(base({ status: "lost" })).reason, "terminal_status");
});

test("not due unless waiting on the customer", () => {
  assert.equal(
    decideFollowUp(base({ waitingStatus: "waiting_us" })).reason,
    "not_waiting_customer"
  );
  assert.equal(
    decideFollowUp(base({ waitingStatus: null })).reason,
    "not_waiting_customer"
  );
});

test("stop request and open task suppress follow-ups", () => {
  assert.equal(decideFollowUp(base({ stopRequested: true })).reason, "stop_requested");
  assert.equal(decideFollowUp(base({ hasOpenTask: true })).reason, "open_task");
});

test("max-3 cap: sentCount >= MAX stops", () => {
  assert.equal(decideFollowUp(base({ sentCount: MAX_FOLLOW_UPS })).reason, "max_reached");
  assert.equal(decideFollowUp(base({ sentCount: MAX_FOLLOW_UPS + 1 })).reason, "max_reached");
});

test("no anchor → never blind-send", () => {
  assert.equal(
    decideFollowUp(base({ lastMeaningfulAt: null })).reason,
    "no_anchor"
  );
});

test("not_yet before the interval elapses, surfaces dueAt", () => {
  const d = decideFollowUp(
    base({ now: new Date("2026-03-02T00:00:00Z") }) // only 24h after anchor
  );
  assert.equal(d.due, false);
  assert.equal(d.reason, "not_yet");
  assert.deepEqual(d.dueAt, new Date("2026-03-03T00:00:00Z"));
});

test("boundary: now exactly at dueAt is due", () => {
  const d = decideFollowUp(base({ now: new Date("2026-03-03T00:00:00Z") }));
  assert.equal(d.due, true);
});

test("spacing: second touch anchors off the last follow-up, not the meaningful interaction", () => {
  // Meaningful interaction long ago; first follow-up sent recently. The next
  // touch must wait intervalHours AFTER the last follow-up, not fire immediately.
  const lastFollowUpAt = new Date("2026-03-10T00:00:00Z");
  const justAfter = new Date(lastFollowUpAt.getTime() + 1 * HOUR);
  const notYet = decideFollowUp(
    base({
      sentCount: 1,
      lastMeaningfulAt: new Date("2026-03-01T00:00:00Z"),
      lastFollowUpAt,
      now: justAfter,
    })
  );
  assert.equal(notYet.reason, "not_yet");

  const wellAfter = new Date(lastFollowUpAt.getTime() + 49 * HOUR);
  const due = decideFollowUp(
    base({
      sentCount: 1,
      lastMeaningfulAt: new Date("2026-03-01T00:00:00Z"),
      lastFollowUpAt,
      now: wellAfter,
    })
  );
  assert.equal(due.due, true);
  if (due.due) assert.equal(due.nextSequence, 2);
});

test("zero/invalid interval clamps to 48h instead of scheduling immediately", () => {
  const anchor = new Date("2026-04-01T00:00:00Z");
  const d = decideFollowUp(
    base({
      intervalHours: 0,
      lastMeaningfulAt: anchor,
      lastFollowUpAt: null,
      now: new Date(anchor.getTime() + 1 * HOUR),
    })
  );
  assert.equal(d.reason, "not_yet");
});
