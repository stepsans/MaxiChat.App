import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateNextScheduledAt, validateScheduleInput } from "./report-schedule-build";

test("once schedules have no next run", () => {
  assert.equal(calculateNextScheduledAt({ frequency: "once", sendTime: "07:00" }), null);
});

test("daily picks today if sendTime is still ahead (WIB)", () => {
  // 2026-06-15 00:00 UTC = 07:00 WIB. sendTime 09:00 WIB is still ahead today.
  const now = new Date("2026-06-15T00:00:00Z");
  const next = calculateNextScheduledAt({ frequency: "daily", sendTime: "09:00", timezone: "Asia/Jakarta" }, now);
  assert.ok(next);
  // 09:00 WIB == 02:00 UTC same day.
  assert.equal(next!.toISOString(), "2026-06-15T02:00:00.000Z");
});

test("daily rolls to tomorrow if sendTime already passed", () => {
  // 06:00 UTC = 13:00 WIB; sendTime 09:00 WIB already passed today.
  const now = new Date("2026-06-15T06:00:00Z");
  const next = calculateNextScheduledAt({ frequency: "daily", sendTime: "09:00", timezone: "Asia/Jakarta" }, now);
  assert.equal(next!.toISOString(), "2026-06-16T02:00:00.000Z");
});

test("weekly picks the next selected ISO weekday", () => {
  // 2026-06-15 is a Monday (ISO 1). Ask for Wednesday (3) at 07:00 WIB.
  const now = new Date("2026-06-15T03:00:00Z"); // 10:00 WIB Monday
  const next = calculateNextScheduledAt(
    { frequency: "weekly", sendTime: "07:00", recurrenceDays: [3], timezone: "Asia/Jakarta" },
    now,
  );
  // Wednesday 2026-06-17 07:00 WIB == 00:00 UTC.
  assert.equal(next!.toISOString(), "2026-06-17T00:00:00.000Z");
});

test("validate rejects empty content and bad email", () => {
  assert.ok(validateScheduleInput({ name: "X", contentTypes: [], frequency: "daily", recipientEmails: ["a@b.com"] }));
  assert.ok(
    validateScheduleInput({ name: "X", contentTypes: ["kpi"], frequency: "daily", recipientEmails: ["nope"] }),
  );
  assert.equal(
    validateScheduleInput({ name: "X", contentTypes: ["kpi"], frequency: "daily", sendTime: "07:00", recipientEmails: ["a@b.com"] }),
    null,
  );
});

test("weekly requires at least one day", () => {
  const err = validateScheduleInput({ name: "X", contentTypes: ["kpi"], frequency: "weekly", recipientEmails: ["a@b.com"] });
  assert.equal(err?.field, "recurrenceDays");
});
