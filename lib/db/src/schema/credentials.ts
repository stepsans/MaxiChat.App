import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// n8n-style OAuth2 credentials, owned by an app user (NOT a WhatsApp account).
// Each row stores the user's own Google Cloud Console OAuth client (Client ID
// and Client Secret), plus the access/refresh tokens we receive after they
// complete the consent screen. Secret fields are stored encrypted-at-rest
// using AES-256-GCM (see api-server/src/lib/crypto.ts); we never persist them
// in plain text. `type` is the credential "app" the user picked in the modal
// (e.g. googleSheetsOAuth2Api, googleSheetsTriggerOAuth2Api).
export const credentialsTable = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    clientId: text("client_id").notNull(),
    // All three *_enc columns hold the base64(iv|ciphertext|tag) envelope
    // produced by encryptString(). Decrypt with decryptString() — never
    // expose these values to the API client.
    clientSecretEnc: text("client_secret_enc").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default([]),
    // Email of the Google account that completed the consent flow, surfaced
    // in the UI so the user can tell which Google login is connected.
    accountEmail: text("account_email"),
    // "disconnected" → never signed in, "connected" → tokens present,
    // "error" → last token refresh failed (UI shows "Reconnect").
    status: text("status").notNull().default("disconnected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    credentialsUserNameUnique: uniqueIndex("credentials_user_name_unique").on(
      t.userId,
      t.name
    ),
  })
);

export type Credential = typeof credentialsTable.$inferSelect;

// Per-WhatsApp-account (ownerPhone) binding from a Google Sheet → the
// `products` table. Sheet is the source of truth: each sync truncates rows
// that no longer appear and upserts the rest. `headerRow` is 1-indexed so a
// value of 1 means row 1 contains the column names.
//
// SECURITY: `userId` pins this config to the app user who created it. We
// query by (userId, ownerPhone) so that if a WhatsApp number is later
// reassigned to a different team/user (user_whatsapp link change), the new
// user does NOT inherit the prior tenant's spreadsheet binding.
// `ownerPhone` alone is still unique-indexed because a given number can
// only be paired by one user at a time.
export const productSyncConfigTable = pgTable(
  "product_sync_config",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    ownerPhone: text("owner_phone").notNull(),
    credentialId: integer("credential_id")
      .notNull()
      .references(() => credentialsTable.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id").notNull(),
    sheetName: text("sheet_name").notNull(),
    headerRow: integer("header_row").notNull().default(1),
    autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(false),
    intervalMinutes: integer("interval_minutes").notNull().default(15),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // "idle" before first sync; "ok" / "error" after each run. lastSyncError
    // is the human-readable message we surface in the UI.
    lastSyncStatus: text("last_sync_status").notNull().default("idle"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    productSyncOwnerPhoneUnique: uniqueIndex(
      "product_sync_owner_phone_unique"
    ).on(t.ownerPhone),
  })
);

export type ProductSyncConfig = typeof productSyncConfigTable.$inferSelect;

// Per-WhatsApp-account (ownerPhone) binding from a Google Sheet → the
// `knowledge_entries` table. Same shape and semantics as productSyncConfigTable
// but for the Knowledge Base. Sheet is the source of truth: each sync replaces
// the owner's knowledge entries with the sheet contents.
export const knowledgeSyncConfigTable = pgTable(
  "knowledge_sync_config",
  {
    id: serial("id").primaryKey(),
    // Tenant-binding: every sync run asserts cfg.userId === userWhatsapp.userId
    // for the linked ownerPhone before mutating per-user knowledge entries.
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    ownerPhone: text("owner_phone").notNull(),
    credentialId: integer("credential_id")
      .notNull()
      .references(() => credentialsTable.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id").notNull(),
    sheetName: text("sheet_name").notNull(),
    headerRow: integer("header_row").notNull().default(1),
    autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(false),
    intervalMinutes: integer("interval_minutes").notNull().default(15),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncStatus: text("last_sync_status").notNull().default("idle"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    knowledgeSyncOwnerPhoneUnique: uniqueIndex(
      "knowledge_sync_owner_phone_unique"
    ).on(t.ownerPhone),
  })
);

export type KnowledgeSyncConfig = typeof knowledgeSyncConfigTable.$inferSelect;

// Per-WhatsApp-account binding from a Google Sheet → the `text_shortcuts`
// table. Same shape and semantics as the knowledge/product sync configs:
// sheet is the source of truth, deletes apply on each run.
export const shortcutSyncConfigTable = pgTable(
  "shortcut_sync_config",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    ownerPhone: text("owner_phone").notNull(),
    credentialId: integer("credential_id")
      .notNull()
      .references(() => credentialsTable.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id").notNull(),
    sheetName: text("sheet_name").notNull(),
    headerRow: integer("header_row").notNull().default(1),
    autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(false),
    intervalMinutes: integer("interval_minutes").notNull().default(15),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncStatus: text("last_sync_status").notNull().default("idle"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    shortcutSyncOwnerPhoneUnique: uniqueIndex(
      "shortcut_sync_owner_phone_unique"
    ).on(t.ownerPhone),
  })
);

export type ShortcutSyncConfig = typeof shortcutSyncConfigTable.$inferSelect;

// Per-WhatsApp-account (ownerPhone) binding for EXPORTING sales orders to a
// Google Sheet. Unlike the product/knowledge/shortcut sync configs this is a
// one-way PUSH (app → sheet, append-only): each saved order is appended as a
// row to `sheetName` (default "sales order"). No headerRow/auto-sync/interval
// because export is on-demand. Requires a credential whose OAuth scopes grant
// read-WRITE spreadsheets access (see SCOPES_BY_TYPE in routes/credentials.ts).
export const salesOrderSyncConfigTable = pgTable(
  "sales_order_sync_config",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    ownerPhone: text("owner_phone").notNull(),
    credentialId: integer("credential_id")
      .notNull()
      .references(() => credentialsTable.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id").notNull(),
    sheetName: text("sheet_name").notNull().default("sales order"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncStatus: text("last_sync_status").notNull().default("idle"),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    salesOrderSyncOwnerPhoneUnique: uniqueIndex(
      "sales_order_sync_owner_phone_unique"
    ).on(t.ownerPhone),
  })
);

export type SalesOrderSyncConfig =
  typeof salesOrderSyncConfigTable.$inferSelect;
