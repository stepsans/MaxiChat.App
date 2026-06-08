import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { invoicesTable } from "./invoices";

// Dunning (collection) audit log (Billing v2 — FASE F). One row per dunning
// STEP taken against an overdue `open` invoice. The UNIQUE (invoice_id, step)
// index is the idempotency guard: each step (reminder/suspend/terminate) is
// emitted at most once per invoice, so a re-run of the daily sweep never
// double-sends a reminder or re-suspends a tenant.
export const dunningSteps = [
  "reminder_0",
  "reminder_3",
  "reminder_7",
  "suspended",
  "terminated",
] as const;
export type DunningStep = (typeof dunningSteps)[number];

export const invoiceDunningLogTable = pgTable(
  "invoice_dunning_log",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    // Which step was taken (see dunningSteps).
    step: text("step").notNull(),
    // How the tenant was notified: in_app | email | whatsapp.
    channel: text("channel").notNull().default("in_app"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_dunning_step_unique").on(t.invoiceId, t.step),
    index("invoice_dunning_invoice_idx").on(t.invoiceId),
  ]
);

export type InvoiceDunningLogRow = typeof invoiceDunningLogTable.$inferSelect;
