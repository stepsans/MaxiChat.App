import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Paid token boosters (add-on top-ups) — the SECOND quota bucket alongside the
// monthly grant in tenant_quota. Two buckets are deliberately separate (LOCKED
// spec B):
//   - Grant  → monthly, use-it-or-lose-it, computed live vs tenant_quota.tokenLimit.
//   - Booster → bought separately, 90-day expiry from purchase, carries across
//               billing periods until it expires.
// Consumption order (B3): grant first (it will lapse anyway), then boosters
// FIFO by SOONEST expiry — so a booster about to lapse is spent before a fresh
// one. `remainingTokens` is a STORED decrementing counter (it must persist
// across period resets — a live computation would wrongly "restore" used
// booster tokens when the period rolls over).
export const tokenBoostersTable = pgTable(
  "token_boosters",
  {
    id: serial("id").primaryKey(),
    // Always the tenant OWNER (member usage rolls up to the owner).
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Tokens granted by this purchase, and how many are left.
    amountTokens: integer("amount_tokens").notNull(),
    remainingTokens: integer("remaining_tokens").notNull(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // purchasedAt + 90 days. After this the booster no longer counts toward the
    // plafon, and the daily expiry job flips status to "expired".
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // active → depleted (remainingTokens hit 0) | expired (past expiresAt).
    // Only "active" rows with remainingTokens > 0 and expiresAt > now are spent.
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Hot lookup: an owner's spendable boosters in FIFO-by-expiry order.
    index("token_boosters_owner_status_expiry_idx").on(
      t.ownerUserId,
      t.status,
      t.expiresAt
    ),
  ]
);

export type TokenBoosterRow = typeof tokenBoostersTable.$inferSelect;
