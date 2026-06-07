import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { usersTable } from "./auth";

// Payment / purchase ledger (Hybrid model FASE 0). One row per checkout: a plan
// purchase, an add-on top-up, or a renewal. Money is whole Indonesian Rupiah.
// `externalId` is the payment-provider reference (e.g. Xendit invoice id) used
// for idempotent webhook reconciliation — a webhook that arrives twice must
// find the row already `paid` and do nothing. `rawPayload` stores the last
// provider payload for audit/debugging.
export const paymentKinds = ["plan", "addon", "renewal", "cart"] as const;
export type PaymentKind = (typeof paymentKinds)[number];

export const paymentStatuses = ["pending", "paid", "expired", "failed"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

// A single line in a cart checkout. Stored in payments.line_items (jsonb) when
// kind="cart". Prices are snapshotted at checkout (whole Rupiah) so the invoice
// PDF and settlement reflect what the customer actually agreed to pay even if
// the catalog price later changes.
export type PaymentLineItem = {
  kind: "plan" | "addon";
  refId: number;
  quantity: number;
  name: string;
  unitPriceIdr: number;
  lineAmountIdr: number;
};

export const paymentsTable = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // plans.id or addons.id depending on kind (nullable for plain renewals).
    refId: integer("ref_id"),
    // Number of units purchased (e.g. how many token top-ups). Default 1.
    quantity: integer("quantity").notNull().default(1),
    amountIdr: integer("amount_idr").notNull().default(0),
    status: text("status").notNull().default("pending"),
    provider: text("provider").notNull().default("xendit"),
    // Provider invoice/charge id for reconciliation; unique when present.
    externalId: text("external_id"),
    // Hosted checkout URL the tenant is redirected to.
    invoiceUrl: text("invoice_url"),
    // Last provider webhook payload, for audit.
    rawPayload: jsonb("raw_payload"),
    // Cart line items (kind="cart"); null for legacy single-item payments.
    lineItems: jsonb("line_items").$type<PaymentLineItem[]>(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("payments_external_id_unique").on(t.externalId)]
);

export const paymentKindSchema = z.enum(paymentKinds);
export const paymentStatusSchema = z.enum(paymentStatuses);

export type PaymentRow = typeof paymentsTable.$inferSelect;
