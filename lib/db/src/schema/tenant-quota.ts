import {
  pgTable,
  serial,
  integer,
  bigint,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { plansTable } from "./plans";

// One row per tenant OWNER holding the PREPAID allowance (plafon) currently
// granted to them (Hybrid model FASE 0). The limits are the authoritative caps
// the enforcement layer (FASE 3) will read; actual "used" amounts are computed
// live from existing tables (aiUsageEventsTable / channel + member counts) to
// avoid a second source of truth that could drift.
//
// A limit = the active plan's quota + the sum of add-on top-ups bought within
// the current period. `planId` records which plan is currently active (nullable
// for tenants who have not purchased one yet — they fall back to defaults).
export const tenantQuotaTable = pgTable(
  "tenant_quota",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    planId: integer("plan_id").references(() => plansTable.id, {
      onDelete: "set null",
    }),
    // Prepaid caps for the current period (plan quota + add-on top-ups).
    tokenLimit: integer("token_limit").notNull().default(0),
    channelLimit: integer("channel_limit").notNull().default(0),
    userLimit: integer("user_limit").notNull().default(0),
    // Object Storage cap in BYTES (plan base + storage add-on top-ups).
    storageLimit: bigint("storage_limit", { mode: "number" })
      .notNull()
      .default(0),
    // Current quota period; aligns with the subscription period. Null until a
    // plan is purchased.
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("tenant_quota_user_unique").on(t.userId)]
);

export type TenantQuotaRow = typeof tenantQuotaTable.$inferSelect;
