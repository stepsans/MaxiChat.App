// Pure, db-free wallet math (Billing v2 — Credit/Wallet). Kept free of any
// @workspace/db import so it stays unit-testable under the node:test runner.
// All money is whole Rupiah; balances are never negative.

// A wallet ledger entry as needed for balance math (subset of the table row).
export type WalletEntry = {
  deltaIdr: number;
  expiresAt: Date | null;
};

// Sum the non-expired entries into the current spendable balance. An entry with
// a past `expiresAt` contributes 0 (the expiry job zeroes it out for real, but
// reads must not count it meanwhile). Clamped at 0 — a wallet can never owe.
export function spendableBalance(entries: WalletEntry[], now: Date): number {
  let sum = 0;
  for (const e of entries) {
    if (e.expiresAt && e.expiresAt.getTime() <= now.getTime()) continue;
    sum += e.deltaIdr;
  }
  return Math.max(0, sum);
}

// How a wallet balance is applied to an order total. `walletApplied` is debited
// from the wallet; `remaining` is what still must be paid via the gateway. The
// wallet is spent FIRST, capped at the order total (never creates change).
export type WalletSplit = {
  walletApplied: number;
  remaining: number;
};

export function splitWithWallet(
  orderTotalIdr: number,
  walletBalanceIdr: number
): WalletSplit {
  const total = Math.max(0, Math.floor(orderTotalIdr));
  const balance = Math.max(0, Math.floor(walletBalanceIdr));
  const walletApplied = Math.min(total, balance);
  return { walletApplied, remaining: total - walletApplied };
}
