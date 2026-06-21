import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planBoosterConsumption,
  boosterOverflowForCharge,
} from "./booster-consume";

const b = (id: number, remainingTokens: number, iso: string) => ({
  id,
  remainingTokens,
  expiresAt: new Date(iso),
});

test("boosterOverflowForCharge: charge fully inside grant → 0", () => {
  assert.equal(
    boosterOverflowForCharge({ grantLimit: 10_000, usageBeforeCharge: 2_000, chargeTokens: 500 }),
    0
  );
});

test("boosterOverflowForCharge: charge straddles the grant boundary", () => {
  // grant 10k, already used 9.8k, charge 500 → 300 over grant.
  assert.equal(
    boosterOverflowForCharge({ grantLimit: 10_000, usageBeforeCharge: 9_800, chargeTokens: 500 }),
    300
  );
});

test("boosterOverflowForCharge: already past grant → whole charge spills", () => {
  assert.equal(
    boosterOverflowForCharge({ grantLimit: 10_000, usageBeforeCharge: 12_000, chargeTokens: 400 }),
    400
  );
});

test("boosterOverflowForCharge: no grant bucket → whole charge spills", () => {
  assert.equal(
    boosterOverflowForCharge({ grantLimit: 0, usageBeforeCharge: 0, chargeTokens: 400 }),
    400
  );
});

test("planBoosterConsumption: FIFO by soonest expiry, spanning two boosters", () => {
  const boosters = [
    b(1, 100, "2026-09-01T00:00:00Z"), // soonest
    b(2, 500, "2026-12-01T00:00:00Z"),
  ];
  const { decrements, unmet } = planBoosterConsumption(300, boosters);
  assert.equal(unmet, 0);
  assert.deepEqual(decrements, [
    { id: 1, decrementBy: 100, newRemaining: 0 },
    { id: 2, decrementBy: 200, newRemaining: 300 },
  ]);
});

test("planBoosterConsumption: skips empty boosters, reports unmet shortfall", () => {
  const boosters = [b(1, 0, "2026-08-01T00:00:00Z"), b(2, 50, "2026-09-01T00:00:00Z")];
  const { decrements, unmet } = planBoosterConsumption(200, boosters);
  assert.deepEqual(decrements, [{ id: 2, decrementBy: 50, newRemaining: 0 }]);
  assert.equal(unmet, 150);
});

test("planBoosterConsumption: zero overflow is a no-op", () => {
  assert.deepEqual(planBoosterConsumption(0, [b(1, 100, "2026-09-01T00:00:00Z")]), {
    decrements: [],
    unmet: 0,
  });
});
