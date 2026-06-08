import {
  pgTable,
  serial,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// One row per tenant OWNER holding the data-retention policy the tenant has
// chosen. Each column is a maximum age in DAYS; a NULL value means "keep
// forever" (unlimited) for that data class. The background retention purger
// reads these and deletes rows/objects whose age exceeds the limit.
//
// The selectable value is bounded by the owner's active plan
// (`plans.retentionLimitDays`): a tenant can keep data for SHORTER than the
// plan cap, never longer. Enforcement of that clamp lives in the route, not the
// schema (a plan downgrade leaves a now-too-large value here, which the purger
// still honors against the live plan cap).
export const retentionSettingsTable = pgTable(
  "retention_settings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Max age (days) for chat messages; null = unlimited.
    chatDays: integer("chat_days"),
    // Max age (days) for Object Storage media (media_objects + the files).
    mediaDays: integer("media_days"),
    // Max age (days) for AI usage events (the "logs" class).
    logDays: integer("log_days"),
    // Max age (days) for usage/analytics snapshots.
    analyticsDays: integer("analytics_days"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("retention_settings_user_unique").on(t.userId)]
);

export type RetentionSettingsRow = typeof retentionSettingsTable.$inferSelect;
