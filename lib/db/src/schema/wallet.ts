import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Tenant credit wallet (Billing v2 — Credit/Wallet). One singleton row per
// tenant OWNER holding the aggregate balance (whole Rupiah, never negative).
// The wallet is where downgrade/remove PRORATION credits land (instead of a
// cash refund), plus promo/referral/compensation credits. At checkout the
// balance is debited BEFORE the payment gateway, so a tenant spends credit
// before paying real money.
//
// The balance is materialized here for fast reads; `wallet_transactions` is the
// immutable audit ledger and the source of truth (balance == SUM(delta) of the
// non-expired transactions).
export const tenantWalletTable = pgTable(
  "tenant_wallet",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    balanceIdr: integer("balance_idr").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("tenant_wallet_user_unique").on(t.userId)]
);

// Immutable wallet ledger. Each row is one credit (+delta) or debit (-delta).
//   - kind: proration_credit | promo | referral | compensation | consumption |
//           adjustment. Credits sourced from a customer's own money
//           (proration_credit) are a LIABILITY; promo/referral are NOT revenue
//           and may carry an expiry.
//   - sourceRef: free-text ref to the originating entity (e.g. "payment:123",
//           "invoice:45") for audit; never load-bearing.
//   - expiresAt: when a credit lapses (promo/referral); null = never expires.
export const walletTxnKinds = [
  "proration_credit",
  "promo",
  "referral",
  "compensation",
  "consumption",
  "adjustment",
] as const;
export type WalletTxnKind = (typeof walletTxnKinds)[number];

export const walletTransactionsTable = pgTable(
  "wallet_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Signed whole Rupiah: positive = credit, negative = debit.
    deltaIdr: integer("delta_idr").notNull(),
    kind: text("kind").notNull(),
    sourceRef: text("source_ref"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("wallet_transactions_user_idx").on(t.userId)]
);

export type TenantWalletRow = typeof tenantWalletTable.$inferSelect;
export type WalletTransactionRow = typeof walletTransactionsTable.$inferSelect;
