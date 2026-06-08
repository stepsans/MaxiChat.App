import { pgTable, integer, text, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Platform-level tax (PPN) configuration (Billing v2 — FASE G). SINGLETON row
// (id pinned to 1) holding the operator's ONE tax policy applied to every
// invoice at issue time. Defaults are fully INERT: `enabled=false` + `rate_bps=0`
// means tax is 0 on every invoice — identical to pre-FASE-G behavior — until the
// operator turns it on. The chosen rate is SNAPSHOTTED into invoices.tax_idr at
// issue, so a later rate change never rewrites financial history.
//
//   - rate_bps : tax rate in BASIS POINTS (1100 = 11% PPN). Integer keeps money
//                math exact; whole-Rupiah rounding happens in the pure builder.
//   - inclusive: true  → catalog/line prices already INCLUDE tax; the invoice
//                        decomposes gross into net + tax (total unchanged — the
//                        non-breaking B2C default).
//                false → tax is ADDED on top of net line amounts (B2B-style;
//                        only applied to unpaid monthly_close bills, never to an
//                        already-collected payment amount).
//   - label    : display name on invoices/UI (e.g. "PPN").
export const taxSettingsTable = pgTable(
  "tax_settings",
  {
    // Pinned to 1 so there is always exactly one row (upsert on id).
    id: integer("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    rateBps: integer("rate_bps").notNull().default(0),
    inclusive: boolean("inclusive").notNull().default(true),
    label: text("label").notNull().default("PPN"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    singletonCheck: check("tax_settings_singleton", sql`${t.id} = 1`),
  })
);

export type TaxSettingsRow = typeof taxSettingsTable.$inferSelect;
