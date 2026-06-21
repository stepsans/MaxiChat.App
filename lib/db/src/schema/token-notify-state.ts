import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Anti-spam state for the token-quota threshold emails (spec E1: 80/20/5/0%).
// One row per owner records the most severe level we have ALREADY emailed for in
// the CURRENT period. We email only when the level escalates (ok→warn80→crit5→
// depleted), and reset when the period rolls over (periodStart changes) — so a
// tenant gets at most one email per threshold per period, never a flood.
export const tokenNotifyStateTable = pgTable(
  "token_notify_state",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The most severe notifyLevel emailed so far this period.
    lastLevel: text("last_level").notNull().default("ok"),
    // The period the lastLevel belongs to; a change resets the ladder.
    periodStart: timestamp("period_start", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("token_notify_state_owner_unique").on(t.ownerUserId)]
);

export type TokenNotifyStateRow = typeof tokenNotifyStateTable.$inferSelect;
