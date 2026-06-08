import { pgTable, integer, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Platform-level OVERAGE rates (Billing v2 — Overage engine). SINGLETON row
// (id pinned to 1) holding the operator's tariffs for usage ABOVE the prepaid
// `tenant_quota` plafon, billed as `usage` lines on the monthly_close invoice.
//
// Defaults are fully INERT: `enabled=false` + all prices 0 → no overage is ever
// charged (identical to pre-overage behavior) until the operator turns it on.
// The chosen rates are read at close time and SNAPSHOTTED into the invoice
// line, so a later rate change never rewrites financial history.
//
//   - token_unit          : block size for AI tokens (e.g. 100 → charge per 100
//                           tokens over the plafon). Whole blocks only.
//   - token_unit_price_idr: price per token block, whole Rupiah.
//   - storage_gb_day_price_idr: price per GB-DAY of average-daily storage above
//                           the storage plafon (fair + abuse-resistant vs peak).
export const overageRatesTable = pgTable(
  "overage_rates",
  {
    id: integer("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    tokenUnit: integer("token_unit").notNull().default(100),
    tokenUnitPriceIdr: integer("token_unit_price_idr").notNull().default(0),
    storageGbDayPriceIdr: integer("storage_gb_day_price_idr")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    singletonCheck: check("overage_rates_singleton", sql`${t.id} = 1`),
  })
);

export type OverageRatesRow = typeof overageRatesTable.$inferSelect;
