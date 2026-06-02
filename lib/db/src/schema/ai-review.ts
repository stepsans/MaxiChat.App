import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";
import { credentialsTable } from "./credentials";

// A user-defined output column for the receipt recap. `name` is the literal
// Google Sheet header text; `hint` is an optional natural-language instruction
// passed to the OCR model so it knows what to extract for that column (e.g.
// "Tanggal nota" → hint "tanggal yang tertera di nota, format YYYY-MM-DD").
export interface AiReviewColumn {
  name: string;
  hint?: string;
}

// "AI Review" = receipt/expense recap. Cashiers post receipt (nota) photos in a
// WhatsApp group; at `scheduleTime` (in `timezone`) each day the AI OCRs every
// new photo, extracts the user-defined `columns`, appends one row per receipt to
// the bound Google Sheet, and optionally uploads the photo to a Drive folder.
//
// One config per group per channel (unique on channelId+groupJid). Owner-scoped
// via userId so a channel/phone reassignment can't leak a prior tenant's sheet
// binding — every read/run re-asserts the channel still belongs to userId.
export const aiReviewConfigTable = pgTable(
  "ai_review_config",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    // WhatsApp group JID (ends in @g.us) stored in chats.phone_number.
    groupJid: text("group_jid").notNull(),
    groupName: text("group_name").notNull().default(""),
    // Sheets credential (read-write spreadsheets scope) + target spreadsheet/tab.
    sheetCredentialId: integer("sheet_credential_id")
      .notNull()
      .references(() => credentialsTable.id, { onDelete: "cascade" }),
    spreadsheetId: text("spreadsheet_id").notNull(),
    spreadsheetUrl: text("spreadsheet_url"),
    sheetTab: text("sheet_tab").notNull(),
    // User-defined output columns: AiReviewColumn[]. Row 1 of the tab is kept in
    // lock-step with these names; the OCR model is asked to extract each one.
    columns: jsonb("columns").notNull().default([]),
    // Optional Google Drive output. Nullable so the menu/structure works before
    // the user connects Drive — uploads are skipped gracefully when unset.
    driveCredentialId: integer("drive_credential_id").references(
      () => credentialsTable.id,
      { onDelete: "set null" }
    ),
    driveFolderId: text("drive_folder_id"),
    driveFolderName: text("drive_folder_name"),
    // Scanner AI: when on, each archived receipt photo is run through document
    // detection + perspective deskew + enhancement (like a phone scanner app)
    // before upload to Drive. Off = archive the photo as-is. OCR is unaffected.
    scannerAi: boolean("scanner_ai").notNull().default(false),
    // Daily cut-off, "HH:mm" in `timezone` (IANA, default Asia/Jakarta / WIB).
    scheduleTime: text("schedule_time").notNull().default("18:00"),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),
    enabled: boolean("enabled").notNull().default(false),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // Local YYYY-MM-DD of the last run in `timezone` — the "already ran today"
    // guard so the once-per-day scheduler can't double-fire within the minute.
    lastRunDate: text("last_run_date"),
    lastRunStatus: text("last_run_status").notNull().default("idle"),
    lastRunError: text("last_run_error"),
    lastRunCount: integer("last_run_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    aiReviewChannelGroupUnique: uniqueIndex(
      "ai_review_channel_group_unique"
    ).on(t.channelId, t.groupJid),
  })
);

export type AiReviewConfig = typeof aiReviewConfigTable.$inferSelect;
