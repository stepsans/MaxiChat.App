import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const whatsappSessionTable = pgTable("whatsapp_session", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("disconnected"),
  qrCode: text("qr_code"),
  phoneNumber: text("phone_number"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WhatsappSession = typeof whatsappSessionTable.$inferSelect;
