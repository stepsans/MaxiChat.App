import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  doublePrecision,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { paymentsTable } from "./payments";

// Formal, IMMUTABLE invoice record (Billing v2 — FASE A). One invoice is the
// authoritative financial document for a billing event; once written it is
// never mutated (prices are snapshotted, so a later catalog price change can
// NOT rewrite history). Invoices are the source of truth for revenue / MRR /
// ARPU / billing history.
//
// `source` distinguishes how the invoice was raised:
//   - "payment"       — derived from a settled `payments` row (FASE A).
//   - "monthly_close" — raised by the monthly-close job (FASE B; period_* set).
// `paymentId` links a payment-derived invoice back to its ledger row and is
// UNIQUEly indexed so a payment yields at most ONE invoice (idempotent
// settlement + backfill). Monthly-close invoices carry a null paymentId.
export const invoiceSources = ["payment", "monthly_close"] as const;
export type InvoiceSource = (typeof invoiceSources)[number];

export const invoiceStatuses = ["open", "paid", "void"] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

// Line-item kinds. Payment-derived lines reuse the catalog kinds (plan/addon);
// the remaining kinds are reserved for later phases (proration, recurring
// subscription items, metered usage) so the schema needs no change to support
// FASE C/D.
export const invoiceLineTypes = [
  "plan",
  "addon",
  "token_booster",
  "seat",
  "channel",
  "storage",
  "proration_credit",
  "proration_charge",
  "usage",
  "other",
] as const;
export type InvoiceLineType = (typeof invoiceLineTypes)[number];

export const invoicesTable = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Human-friendly, stable invoice number (e.g. INV-2026-000123).
    invoiceNumber: text("invoice_number").notNull(),
    source: text("source").notNull().default("payment"),
    // The settled payment this invoice was raised from (null for monthly_close).
    // ON DELETE SET NULL: deleting a payment must NOT delete its immutable
    // invoice — the financial record outlives the ledger row.
    paymentId: integer("payment_id").references(() => paymentsTable.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("paid"),
    currency: text("currency").notNull().default("IDR"),
    // Whole Indonesian Rupiah, snapshotted at issue time.
    subtotalIdr: integer("subtotal_idr").notNull().default(0),
    taxIdr: integer("tax_idr").notNull().default(0),
    totalIdr: integer("total_idr").notNull().default(0),
    // Period covered (monthly_close invoices); null for one-off purchases.
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_invoice_number_unique").on(t.invoiceNumber),
    // One invoice per payment. NULL paymentIds are distinct in Postgres so any
    // number of monthly_close invoices coexist; this is the idempotency guard
    // for payment-derived invoices (settlement retry + backfill).
    uniqueIndex("invoices_payment_id_unique").on(t.paymentId),
    index("invoices_user_id_idx").on(t.userId),
  ]
);

export const invoiceLineItemsTable = pgTable(
  "invoice_line_items",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    lineType: text("line_type").notNull(),
    // plans.id / addons.id (or other catalog ref); null for synthesized lines.
    refId: integer("ref_id"),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceIdr: integer("unit_price_idr").notNull().default(0),
    amountIdr: integer("amount_idr").notNull().default(0),
    // Reserved for FASE D proration (remaining_days / total_days_in_month) so
    // every prorated charge is auditable. Null for full-price lines.
    prorationFactor: doublePrecision("proration_factor"),
    calculationSource: text("calculation_source"),
    coversFrom: timestamp("covers_from", { withTimezone: true }),
    coversTo: timestamp("covers_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("invoice_line_items_invoice_id_idx").on(t.invoiceId)]
);

export type InvoiceRow = typeof invoicesTable.$inferSelect;
export type InvoiceLineItemRow = typeof invoiceLineItemsTable.$inferSelect;
