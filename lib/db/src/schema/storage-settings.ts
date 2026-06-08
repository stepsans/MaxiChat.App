import {
  pgTable,
  integer,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Platform-level storage enforcement configuration (Billing v2 — FASE C).
// SINGLETON row (id pinned to 1) holding the operator's ONE policy for storage
// quota enforcement + monitoring. Defaults are fully INERT:
// `enforcement_enabled = false` means uploads are NEVER blocked — identical to
// pre-FASE-C behavior — until the operator turns it on.
//
//   - enforcement_enabled : when true, user-initiated uploads (chat media,
//                           product/flow images) are blocked once the tenant's
//                           live media storage exceeds its plafon. Inbound
//                           WhatsApp media ingestion is NEVER blocked (core
//                           data flow), regardless of this flag.
//   - grace_percent       : slack allowed ABOVE the hard limit before blocking
//                           (e.g. 10 = block at 110% of the plafon). Integer
//                           percent; 0 = block exactly at the limit.
//   - warn_percent        : monitoring threshold (e.g. 80 = surface a "near
//                           limit" warning at 80% of the plafon). Display-only;
//                           it never blocks.
export const storageSettingsTable = pgTable(
  "storage_settings",
  {
    // Pinned to 1 so there is always exactly one row (upsert on id).
    id: integer("id").primaryKey().default(1),
    enforcementEnabled: boolean("enforcement_enabled").notNull().default(false),
    gracePercent: integer("grace_percent").notNull().default(0),
    warnPercent: integer("warn_percent").notNull().default(80),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    singletonCheck: check("storage_settings_singleton", sql`${t.id} = 1`),
  })
);

export type StorageSettingsRow = typeof storageSettingsTable.$inferSelect;
