import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// One row per app user. Tracks the live status of that user's WhatsApp
// connection (status / QR / connected phone). The Baileys cryptographic keys
// themselves live in the per-user auth dir on disk, not in this table.
//
// userId is nullable in the schema only so an in-place `db push` does not
// fail on the existing pre-auth row; the startup seed backfills it and all
// code paths treat it as required.
export const whatsappSessionTable = pgTable("whatsapp_session", {
  id: serial("id").primaryKey(),
  // Logical "unique" per user — enforced in code (one row per userId) rather
  // than via a DB constraint, so an in-place push doesn't fail on the
  // pre-auth row.
  userId: integer("user_id"),
  status: text("status").notNull().default("disconnected"),
  qrCode: text("qr_code"),
  phoneNumber: text("phone_number"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WhatsappSession = typeof whatsappSessionTable.$inferSelect;
