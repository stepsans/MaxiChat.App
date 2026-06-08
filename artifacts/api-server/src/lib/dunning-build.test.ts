import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysOverdue,
  dunningDecision,
  dunningStepsDue,
  dueDateForInvoice,
  DEFAULT_DUNNING_SCHEDULE,
} from "./dunning-build";

const day = (n: number) => new Date(2026, 0, 1 + n);

test("daysOverdue floors whole days", () => {
  assert.equal(daysOverdue(day(0), day(0)), 0);
  assert.equal(daysOverdue(day(0), day(3)), 3);
  assert.equal(daysOverdue(day(5), day(2)), -3);
});

test("not due yet → null decision", () => {
  assert.equal(dunningDecision(-1), null);
});

test("escalation ladder", () => {
  assert.deepEqual(dunningDecision(0), { step: "reminder_0", effect: "none" });
  assert.deepEqual(dunningDecision(3), { step: "reminder_3", effect: "none" });
  assert.deepEqual(dunningDecision(7), { step: "reminder_7", effect: "none" });
  assert.deepEqual(dunningDecision(14), { step: "suspended", effect: "suspend" });
  assert.deepEqual(dunningDecision(30), { step: "terminated", effect: "terminate" });
  assert.deepEqual(dunningDecision(99), { step: "terminated", effect: "terminate" });
});

test("stepsDue catches up offline tenants in order", () => {
  assert.deepEqual(dunningStepsDue(8), ["reminder_0", "reminder_3", "reminder_7"]);
  assert.deepEqual(dunningStepsDue(20), [
    "reminder_0",
    "reminder_3",
    "reminder_7",
    "suspended",
  ]);
  assert.deepEqual(dunningStepsDue(-5), []);
});

test("dueDateForInvoice adds term days", () => {
  const issued = day(0);
  assert.equal(
    dueDateForInvoice(issued, 7).getTime(),
    issued.getTime() + 7 * 24 * 60 * 60 * 1000
  );
  assert.equal(dueDateForInvoice(issued, -3).getTime(), issued.getTime());
});

test("default schedule shape", () => {
  assert.equal(DEFAULT_DUNNING_SCHEDULE.suspendDays, 14);
  assert.equal(DEFAULT_DUNNING_SCHEDULE.terminateDays, 30);
});
