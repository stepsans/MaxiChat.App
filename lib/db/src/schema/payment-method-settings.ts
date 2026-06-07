import {
  pgTable,
  integer,
  text,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { credentialsTable } from "./credentials";

// Platform-level payment-method selection + manual-transfer config (Hybrid
// subscription). SINGLETON row (id is pinned to 1) holding which gateway is
// active for every tenant and, when "manual" is chosen, the operator's bank
// account shown on checkout plus the Google Sheet used to verify transfers.
//
// `activeProvider` switches the whole platform between:
//   - "xendit": hosted-invoice checkout (creds live in payment_gateway_config)
//   - "manual": customer transfers to the bank account below; the operator
//     marks the order paid in the verification Google Sheet, and a poller
//     activates the membership.
//
// Bank fields are NOT secrets (they are shown to customers), so they are stored
// in plaintext. The verification sheet is read/written using the operator's own
// Google OAuth credential (credentials table) — same infra tenants use.
export const paymentMethodSettingsTable = pgTable(
  "payment_method_settings",
  {
    // Pinned to 1 so there is always exactly one row (upsert on id).
    id: integer("id").primaryKey().default(1),
    activeProvider: text("active_provider").notNull().default("xendit"),
    // Manual bank-transfer destination (shown to the customer at checkout).
    bankName: text("bank_name"),
    bankAccountNumber: text("bank_account_number"),
    bankAccountHolder: text("bank_account_holder"),
    // Optional extra free-text instructions shown on the manual checkout panel.
    manualInstructions: text("manual_instructions"),
    // Google Sheet verification target (operator's own credential).
    verificationCredentialId: integer("verification_credential_id").references(
      () => credentialsTable.id,
      { onDelete: "set null" }
    ),
    verificationSpreadsheetId: text("verification_spreadsheet_id"),
    verificationSpreadsheetName: text("verification_spreadsheet_name"),
    verificationSheetTab: text("verification_sheet_tab"),
    // Bookkeeping for the verification poller.
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    singletonCheck: check("payment_method_settings_singleton", sql`${t.id} = 1`),
  })
);

export type PaymentMethodSettings =
  typeof paymentMethodSettingsTable.$inferSelect;
