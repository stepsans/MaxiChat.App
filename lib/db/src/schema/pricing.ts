import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

// Global, admin-configurable pricing for the usage-based billing engine.
// Intentionally a SINGLETON: only the row with id=1 is ever read/written (see
// getPricing in the api-server). Prices are whole Indonesian Rupiah (no cents)
// stored as integers. Changing a price takes effect on the NEXT bill
// computation — historical snapshots keep the bill that was computed for them.
export const pricingConfigTable = pgTable("pricing_config", {
  id: serial("id").primaryKey(),
  // Rp per 500 MB of chat database storage, per month.
  dbPricePer500Mb: integer("db_price_per_500mb").notNull().default(50000),
  // Rp per invited child user (supervisor/agent — parent excluded), per month.
  userPricePerUser: integer("user_price_per_user").notNull().default(50000),
  // Rp per 2 channels (billed in buckets of two), per month.
  channelPricePer2: integer("channel_price_per_2").notNull().default(50000),
  // NOTE: AI is no longer metered/billed here — it rides the prepaid credit
  // wallet (platform-ai). The old ai_price_per_100_tokens column was dropped.
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // users.id of the admin who last changed the prices (nullable for the seed row).
  updatedBy: integer("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
});

export const updatePricingSchema = createInsertSchema(pricingConfigTable, {
  dbPricePer500Mb: z.number().int().min(0),
  userPricePerUser: z.number().int().min(0),
  channelPricePer2: z.number().int().min(0),
}).pick({
  dbPricePer500Mb: true,
  userPricePerUser: true,
  channelPricePer2: true,
});

export type UpdatePricing = z.infer<typeof updatePricingSchema>;
export type PricingConfigRow = typeof pricingConfigTable.$inferSelect;
