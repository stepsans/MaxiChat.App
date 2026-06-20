import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTzParts, zonedWallClockToUtc } from "./ai-pipeline-time";

describe("zonedWallClockToUtc", () => {
  it("converts a Jakarta wall-clock cutoff to the right UTC instant (no DST)", () => {
    // 12:00 WIB (UTC+7) on 2026-06-20 → 05:00:00 UTC.
    const utc = zonedWallClockToUtc(2026, 6, 20, 12, 0, "Asia/Jakarta");
    assert.equal(utc.toISOString(), "2026-06-20T05:00:00.000Z");
  });

  it("handles 23:59 WIB", () => {
    const utc = zonedWallClockToUtc(2026, 6, 20, 23, 59, "Asia/Jakarta");
    assert.equal(utc.toISOString(), "2026-06-20T16:59:00.000Z");
  });

  it("normalizes minute 60 to the next hour (prev cutoff + 1 min)", () => {
    // 12:60 WIB == 13:00 WIB → 06:00 UTC.
    const utc = zonedWallClockToUtc(2026, 6, 20, 12, 60, "Asia/Jakarta");
    assert.equal(utc.toISOString(), "2026-06-20T06:00:00.000Z");
  });

  it("respects a different timezone offset (UTC)", () => {
    const utc = zonedWallClockToUtc(2026, 6, 20, 12, 0, "UTC");
    assert.equal(utc.toISOString(), "2026-06-20T12:00:00.000Z");
  });
});

describe("getTzParts", () => {
  it("reads back the wall-clock parts in Jakarta", () => {
    const instant = new Date("2026-06-20T05:00:00.000Z"); // = 12:00 WIB
    const p = getTzParts(instant, "Asia/Jakarta");
    assert.equal(p.year, 2026);
    assert.equal(p.month, 6);
    assert.equal(p.day, 20);
    assert.equal(p.hour, 12);
    assert.equal(p.minute, 0);
  });

  it("round-trips with zonedWallClockToUtc", () => {
    const utc = zonedWallClockToUtc(2026, 1, 15, 8, 30, "Asia/Jakarta");
    const p = getTzParts(utc, "Asia/Jakarta");
    assert.equal(p.hour, 8);
    assert.equal(p.minute, 30);
    assert.equal(p.day, 15);
  });
});
