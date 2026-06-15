import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokensToCredits,
  isGrantExpired,
  effectiveGrant,
  availableBalance,
  planSpend,
  crossedThreshold,
  estimateTotalTokens,
  worstCaseEstimate,
  estDaysLeft,
  creditNoticeLevel,
  remainingPercent,
} from "./credit-math";

// --- tokensToCredits -------------------------------------------------------

test("tokensToCredits applies rate and markup, ceiling to whole credits", () => {
  // 1000 tokens @ 1000/1k, +50% markup → 1000 * 1.5 = 1500.
  assert.equal(tokensToCredits(1000, 1000, 5000), 1500);
});

test("tokensToCredits with no markup is just the rate", () => {
  assert.equal(tokensToCredits(2000, 1000, 0), 2000);
});

test("tokensToCredits ceils a sub-1k call so it is never free", () => {
  // 1 token @ 1000/1k, no markup → 1/1000*1000 = 1 → ceil 1.
  assert.equal(tokensToCredits(1, 1000, 0), 1);
  // 1500 tokens @ 1000/1k, +50% → 1.5*1000*1.5 = 2250.
  assert.equal(tokensToCredits(1500, 1000, 5000), 2250);
  // 1234 tokens @ 1000/1k, no markup → 1234 → ceil 1234.
  assert.equal(tokensToCredits(1234, 1000, 0), 1234);
});

test("tokensToCredits returns 0 for zero/invalid inputs", () => {
  assert.equal(tokensToCredits(0, 1000, 5000), 0);
  assert.equal(tokensToCredits(1000, 0, 5000), 0);
  assert.equal(tokensToCredits(-5, 1000, 5000), 0);
  assert.equal(tokensToCredits(NaN, 1000, 5000), 0);
  assert.equal(tokensToCredits(null, 1000, 5000), 0);
});

// --- expiry ----------------------------------------------------------------

const NOW = new Date("2026-06-15T00:00:00Z");

test("isGrantExpired: past expiry is expired, future is not, null never expires", () => {
  assert.equal(isGrantExpired(new Date("2026-06-14T23:59:59Z"), NOW), true);
  assert.equal(isGrantExpired(new Date("2026-06-16T00:00:00Z"), NOW), false);
  assert.equal(isGrantExpired(null, NOW), false);
});

test("effectiveGrant zeroes an expired grant", () => {
  assert.equal(effectiveGrant(5000, new Date("2026-06-14T00:00:00Z"), NOW), 0);
  assert.equal(effectiveGrant(5000, new Date("2026-06-16T00:00:00Z"), NOW), 5000);
  assert.equal(effectiveGrant(5000, null, NOW), 5000);
});

// --- availableBalance ------------------------------------------------------

test("availableBalance sums unexpired grant + paid minus reserved", () => {
  assert.equal(
    availableBalance({ grantBalance: 1000, grantExpiresAt: null, paidBalance: 500, reserved: 200, now: NOW }),
    1300,
  );
});

test("availableBalance excludes an expired grant", () => {
  assert.equal(
    availableBalance({
      grantBalance: 1000,
      grantExpiresAt: new Date("2026-06-01T00:00:00Z"),
      paidBalance: 500,
      reserved: 0,
      now: NOW,
    }),
    500,
  );
});

test("availableBalance never goes negative", () => {
  assert.equal(
    availableBalance({ grantBalance: 100, grantExpiresAt: null, paidBalance: 0, reserved: 999, now: NOW }),
    0,
  );
});

// --- planSpend (grant-first) -----------------------------------------------

test("planSpend drains grant before paid", () => {
  const p = planSpend(300, { grantBalance: 1000, grantExpiresAt: null, paidBalance: 500, now: NOW });
  assert.deepEqual(p, { fromGrant: 300, fromPaid: 0, grantAfter: 700, paidAfter: 500, shortfall: 0 });
});

test("planSpend spills into paid once grant is exhausted", () => {
  const p = planSpend(1200, { grantBalance: 1000, grantExpiresAt: null, paidBalance: 500, now: NOW });
  assert.deepEqual(p, { fromGrant: 1000, fromPaid: 200, grantAfter: 0, paidAfter: 300, shortfall: 0 });
});

test("planSpend skips an expired grant and uses paid", () => {
  const p = planSpend(300, {
    grantBalance: 1000,
    grantExpiresAt: new Date("2026-06-01T00:00:00Z"),
    paidBalance: 500,
    now: NOW,
  });
  // Expired grant collapses to 0 in the plan, so persisting grantAfter also
  // clears the dead grant.
  assert.deepEqual(p, { fromGrant: 0, fromPaid: 300, grantAfter: 0, paidAfter: 200, shortfall: 0 });
});

test("planSpend reports shortfall when both buckets run dry", () => {
  const p = planSpend(2000, { grantBalance: 500, grantExpiresAt: null, paidBalance: 300, now: NOW });
  assert.deepEqual(p, { fromGrant: 500, fromPaid: 300, grantAfter: 0, paidAfter: 0, shortfall: 1200 });
});

// --- crossedThreshold ------------------------------------------------------

test("crossedThreshold fires once per downward crossing", () => {
  // From 100% baseline down to 18% crosses the 20 threshold.
  assert.equal(crossedThreshold(100, 18), 20);
  // Already at 20, now at 4% → crosses 5.
  assert.equal(crossedThreshold(20, 4), 5);
  // At 5, hits 0 → crosses 0.
  assert.equal(crossedThreshold(5, 0), 0);
});

test("crossedThreshold returns null when no new threshold is crossed", () => {
  assert.equal(crossedThreshold(20, 25), null); // balance went up
  assert.equal(crossedThreshold(20, 18), null); // still between 20 and 5
});

test("crossedThreshold reports the lowest threshold when several are crossed at once", () => {
  // A big drop from 100% straight to 2% crosses both 20 and 5 → report 5.
  assert.equal(crossedThreshold(100, 2), 5);
});

// --- worst-case estimate / runway ------------------------------------------

test("estimateTotalTokens adds an assumed output to the input", () => {
  assert.equal(estimateTotalTokens(500, 1024), 1524);
  assert.equal(estimateTotalTokens(0), 1024); // default output
});

test("worstCaseEstimate prices at the most expensive enabled engine", () => {
  const engines = [{ creditPer1kToken: 600 }, { creditPer1kToken: 1500 }];
  // total tokens = 1000 input + 1000 output = 2000; @1500/1k, +50% markup:
  // 2 * 1500 * 1.5 = 4500.
  assert.equal(worstCaseEstimate(1000, engines, 5000, 1000), 4500);
});

test("worstCaseEstimate is 0 when no engines are enabled", () => {
  assert.equal(worstCaseEstimate(1000, [], 5000), 0);
});

test("estDaysLeft projects runway from windowed burn", () => {
  // 9000 credits left, 3000 spent over 30 days → 100/day → 90 days.
  assert.equal(estDaysLeft(9000, 3000, 30), 90);
});

test("estDaysLeft is null when there is no measured spend", () => {
  assert.equal(estDaysLeft(9000, 0, 30), null);
});

// --- notice level / remaining percent --------------------------------------

test("remainingPercent reconstructs the period baseline from spend", () => {
  // 20 left, 80 spent → baseline 100 → 20%.
  assert.equal(remainingPercent(20, 80), 20);
  // No spend yet → full.
  assert.equal(remainingPercent(50, 0), 100);
  // Unfunded period → treated as full (not divide-by-zero).
  assert.equal(remainingPercent(0, 0), 100);
});

test("creditNoticeLevel maps percent + spendable balance to the banner", () => {
  assert.equal(creditNoticeLevel(100, 1000, 0), "ok");
  assert.equal(creditNoticeLevel(20, 1000, 0), "low");
  assert.equal(creditNoticeLevel(5, 1000, 0), "critical");
  // At/under the hard-stop floor → empty regardless of percent.
  assert.equal(creditNoticeLevel(50, 0, 0), "empty");
  assert.equal(creditNoticeLevel(50, 10, 10), "empty");
});
