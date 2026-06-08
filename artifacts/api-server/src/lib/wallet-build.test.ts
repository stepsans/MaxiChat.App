import { test } from "node:test";
import assert from "node:assert/strict";
import { spendableBalance, splitWithWallet } from "./wallet-build";

const now = new Date(2026, 5, 1);
const past = new Date(2026, 4, 1);
const future = new Date(2026, 6, 1);

test("spendable sums non-expired entries", () => {
  assert.equal(
    spendableBalance(
      [
        { deltaIdr: 10000, expiresAt: null },
        { deltaIdr: 5000, expiresAt: future },
        { deltaIdr: -3000, expiresAt: null },
      ],
      now
    ),
    12000
  );
});

test("expired credits are excluded", () => {
  assert.equal(
    spendableBalance(
      [
        { deltaIdr: 10000, expiresAt: past },
        { deltaIdr: 2000, expiresAt: null },
      ],
      now
    ),
    2000
  );
});

test("balance never negative", () => {
  assert.equal(
    spendableBalance([{ deltaIdr: -9999, expiresAt: null }], now),
    0
  );
});

test("splitWithWallet spends wallet first, no change", () => {
  assert.deepEqual(splitWithWallet(10000, 3000), {
    walletApplied: 3000,
    remaining: 7000,
  });
  assert.deepEqual(splitWithWallet(5000, 9000), {
    walletApplied: 5000,
    remaining: 0,
  });
  assert.deepEqual(splitWithWallet(0, 9000), {
    walletApplied: 0,
    remaining: 0,
  });
});
