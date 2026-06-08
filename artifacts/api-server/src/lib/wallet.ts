import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  db,
  tenantWalletTable,
  walletTransactionsTable,
  type WalletTxnKind,
  type WalletTransactionRow,
} from "@workspace/db";
import { logger } from "./logger";

// Tenant credit wallet DB layer (Billing v2 — Credit/Wallet). The materialized
// `tenant_wallet.balance_idr` is kept in lockstep with the immutable
// `wallet_transactions` ledger: every credit/debit appends a ledger row AND
// adjusts the balance in ONE transaction. Balance is whole Rupiah, never < 0.

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Live spendable balance = SUM(delta) over NON-expired ledger rows, floored at
// 0. This is the source-of-truth read (the materialized balance is a cache for
// hot paths). Expired credits (expires_at <= now) are excluded.
export async function getWalletBalance(
  ownerUserId: number,
  exec: DbExecutor = db
): Promise<number> {
  const now = new Date();
  const [agg] = await exec
    .select({
      total: sql<number>`cast(coalesce(sum(${walletTransactionsTable.deltaIdr}), 0) as int)`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, ownerUserId),
        or(
          isNull(walletTransactionsTable.expiresAt),
          gt(walletTransactionsTable.expiresAt, now)
        )
      )
    );
  return Math.max(0, agg?.total ?? 0);
}

// Append a ledger row and re-materialize the wallet balance, atomically. A
// positive delta is a credit; negative is a debit. The materialized balance is
// recomputed from the live (non-expired) ledger so it can never drift.
export async function recordWalletTransaction(
  ownerUserId: number,
  deltaIdr: number,
  kind: WalletTxnKind,
  opts: { sourceRef?: string | null; expiresAt?: Date | null } = {},
  exec?: DbExecutor
): Promise<WalletTransactionRow> {
  const run = async (tx: DbExecutor): Promise<WalletTransactionRow> => {
    const [row] = await tx
      .insert(walletTransactionsTable)
      .values({
        userId: ownerUserId,
        deltaIdr: Math.round(deltaIdr),
        kind,
        sourceRef: opts.sourceRef ?? null,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning();

    const balance = await getWalletBalance(ownerUserId, tx);
    await tx
      .insert(tenantWalletTable)
      .values({ userId: ownerUserId, balanceIdr: balance })
      .onConflictDoUpdate({
        target: tenantWalletTable.userId,
        set: { balanceIdr: balance, updatedAt: new Date() },
      });
    return row;
  };

  // Reuse an open transaction when given (settlement path); otherwise open one.
  if (exec) return run(exec);
  return db.transaction(run);
}

// Debit the wallet by up to `amountIdr`, never below zero. Returns the amount
// ACTUALLY debited (min(balance, amount)). Used at checkout to spend credit
// before the gateway. Records a `consumption` ledger row. Caller must run this
// inside the checkout transaction (pass `exec`) so the debit and the order are
// atomic. A zero balance or zero amount is a no-op (returns 0, no ledger row).
export async function debitWallet(
  ownerUserId: number,
  amountIdr: number,
  sourceRef: string | null,
  exec: DbExecutor = db
): Promise<number> {
  const want = Math.max(0, Math.floor(amountIdr));
  if (want === 0) return 0;
  const balance = await getWalletBalance(ownerUserId, exec);
  const debit = Math.min(balance, want);
  if (debit <= 0) return 0;
  await recordWalletTransaction(
    ownerUserId,
    -debit,
    "consumption",
    { sourceRef },
    exec
  );
  return debit;
}

// Owner's wallet ledger, newest-first (for the dashboard history view).
export async function listWalletTransactions(
  ownerUserId: number,
  limit = 50
): Promise<WalletTransactionRow[]> {
  return db
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.userId, ownerUserId))
    .orderBy(desc(walletTransactionsTable.createdAt), desc(walletTransactionsTable.id))
    .limit(limit);
}

// Re-materialize the cached balance for one owner (maintenance / after expiry
// sweeps). Best-effort; logs on failure.
export async function reconcileWalletBalance(ownerUserId: number): Promise<void> {
  try {
    const balance = await getWalletBalance(ownerUserId);
    await db
      .insert(tenantWalletTable)
      .values({ userId: ownerUserId, balanceIdr: balance })
      .onConflictDoUpdate({
        target: tenantWalletTable.userId,
        set: { balanceIdr: balance, updatedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, ownerUserId }, "reconcileWalletBalance failed");
  }
}
