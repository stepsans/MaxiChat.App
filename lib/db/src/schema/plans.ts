import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Admin-configurable subscription plan catalog (Hybrid model FASE 0).
// Prices are whole Indonesian Rupiah (no cents) stored as integers. Quotas
// define the PREPAID allowance a tenant gets while the plan is active; add-ons
// (see addonsTable) top these up within a period. `key` is the stable machine
// identifier that matches users.plan (so existing tiers keep working); `name`
// is the display label the admin can rename freely. Plans are never hard
// deleted — `isActive=false` archives them so historical purchases stay valid.
export const plansTable = pgTable(
  "plans",
  {
    id: serial("id").primaryKey(),
    // Stable machine key (e.g. "basic", "pro"); matches users.plan.
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Whole Rupiah price for one purchase of this plan.
    priceIdr: integer("price_idr").notNull().default(0),
    // Validity granted per purchase, in days (e.g. 30).
    durationDays: integer("duration_days").notNull().default(30),
    // Prepaid allowances granted while the plan is active.
    quotaUsers: integer("quota_users").notNull().default(0),
    quotaChannels: integer("quota_channels").notNull().default(0),
    quotaTokens: integer("quota_tokens").notNull().default(0),
    // Object Storage allowance in BYTES granted while the plan is active.
    // bigint (mode: number) — plans run to GB scale, well within 2^53.
    quotaStorageBytes: bigint("quota_storage_bytes", { mode: "number" })
      .notNull()
      .default(0),
    // Maximum data-retention period (days) a tenant on this plan may select.
    // NULL = unlimited (the tenant may keep data forever). A tenant's chosen
    // retention is clamped to this cap; it is never a floor.
    retentionLimitDays: integer("retention_limit_days"),
    // Entitlement flag: does this plan include the AI Sales Assistant
    // (Enterprise-only sales CRM)? Default false; only the enterprise plan
    // turns it on. Infinity owners always pass regardless of this flag.
    hasAiSalesAssistant: boolean("has_ai_sales_assistant")
      .notNull()
      .default(false),
    isActive: boolean("is_active").notNull().default(true),
    // Display ordering in the catalog (ascending).
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("plans_key_unique").on(t.key)]
);

// Add-on / top-up catalog. Each row is a one-off purchasable that increases a
// tenant's quota within the current period:
//   - "token"     → adds `unitAmount` AI tokens
//   - "channel"   → adds `unitAmount` channel slots
//   - "user_seat" → adds `unitAmount` invited-member seats
//   - "storage"   → adds `unitAmount` BYTES of Object Storage (e.g. 10GB)
export const addonTypes = ["token", "channel", "user_seat", "storage"] as const;
export type AddonType = (typeof addonTypes)[number];

export const addonsTable = pgTable("addons", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  // Units granted per purchase (e.g. 100000 tokens, 1 channel/seat, or
  // 10737418240 bytes of storage). bigint (mode: number) so byte-scale
  // storage add-ons fit; token/channel/seat values stay small integers.
  unitAmount: bigint("unit_amount", { mode: "number" }).notNull().default(0),
  // Whole Rupiah price for one purchase of this add-on.
  priceIdr: integer("price_idr").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const addonTypeSchema = z.enum(addonTypes);

export const insertPlanSchema = createInsertSchema(plansTable, {
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "key hanya boleh huruf kecil, angka, dan _"),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  priceIdr: z.number().int().min(0),
  durationDays: z.number().int().min(1),
  quotaUsers: z.number().int().min(0),
  quotaChannels: z.number().int().min(0),
  quotaTokens: z.number().int().min(0),
  quotaStorageBytes: z.number().int().min(0),
  retentionLimitDays: z.number().int().min(1).nullable().optional(),
  hasAiSalesAssistant: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertAddonSchema = createInsertSchema(addonsTable, {
  type: addonTypeSchema,
  name: z.string().trim().min(1).max(80),
  unitAmount: z.number().int().min(0),
  priceIdr: z.number().int().min(0),
  sortOrder: z.number().int().min(0).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type InsertAddon = z.infer<typeof insertAddonSchema>;
export type PlanRow = typeof plansTable.$inferSelect;
export type AddonRow = typeof addonsTable.$inferSelect;
