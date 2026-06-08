import { pgTable, integer, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Platform-level DUNNING policy (Billing v2 — FASE F). SINGLETON row (id=1)
// gating the collection sweep that escalates OVERDUE `monthly_close` invoices
// toward suspension/termination.
//
// Defaults are fully INERT: `enabled=false` → the sweep is a no-op, so no tenant
// is ever auto-suspended until the operator turns it on. This matters because
// the base model is PREPAID (plan purchases set the period); monthly_close
// invoices may routinely sit unpaid, so auto-suspension must be opt-in.
//
// The day thresholds (relative to invoice `due_at`) tune the ladder:
//   reminder_0/3/7 → keep full access; suspend_days → read-only (suspended);
//   terminate_days → subscription expired.
export const dunningSettingsTable = pgTable(
  "dunning_settings",
  {
    id: integer("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    reminder0Days: integer("reminder0_days").notNull().default(0),
    reminder3Days: integer("reminder3_days").notNull().default(3),
    reminder7Days: integer("reminder7_days").notNull().default(7),
    suspendDays: integer("suspend_days").notNull().default(14),
    terminateDays: integer("terminate_days").notNull().default(30),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    singletonCheck: check("dunning_settings_singleton", sql`${t.id} = 1`),
  })
);

export type DunningSettingsRow = typeof dunningSettingsTable.$inferSelect;
