import {
  pgTable,
  serial,
  integer,
  bigint,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// One row per tenant OWNER per calendar day. Written by the nightly usage
// scheduler so billing/audit/reporting read a stable point-in-time snapshot
// instead of re-aggregating live tables. There is no historical backfill —
// snapshots only start accruing once the scheduler ships.
//
// The four *Charge columns + bill are the bill that was computed FOR this
// snapshot against the pricing config at snapshot time, so a later price change
// never rewrites a past day's bill. Money is whole Indonesian Rupiah.
export const usageSnapshotsTable = pgTable(
  "usage_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Calendar day (UTC) the snapshot represents, e.g. "2026-06-05".
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    // Raw chat-storage footprint (pg_column_size of chats + chat_messages).
    storageBytes: bigint("storage_bytes", { mode: "number" })
      .notNull()
      .default(0),
    // Count of invited child users (supervisor/agent); the owner is excluded.
    userCount: integer("user_count").notNull().default(0),
    // Count of the owner's channels.
    channelCount: integer("channel_count").notNull().default(0),
    // AI tokens consumed in the owner's current billing period at snapshot time.
    tokenUsage: integer("token_usage").notNull().default(0),
    // Bill breakdown computed for this snapshot (Rupiah).
    dbCharge: integer("db_charge").notNull().default(0),
    userCharge: integer("user_charge").notNull().default(0),
    channelCharge: integer("channel_charge").notNull().default(0),
    aiCharge: integer("ai_charge").notNull().default(0),
    totalCharge: integer("total_charge").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_snapshots_user_date_unique").on(
      t.userId,
      t.snapshotDate
    ),
  ]
);

export type UsageSnapshotRow = typeof usageSnapshotsTable.$inferSelect;
