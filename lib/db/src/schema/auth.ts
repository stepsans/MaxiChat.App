import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

// Application users. Currently a fixed allowlist seeded at server startup; no
// public signup endpoint. Passwords are stored as bcrypt hashes.
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Per-user binding to a WhatsApp account. The connected WhatsApp number is
// the `ownerPhone` we already use everywhere as the data-isolation key; this
// mapping pins each app user to exactly one WhatsApp account so different
// users never see each other's chats.
export const userWhatsappTable = pgTable("user_whatsapp", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  ownerPhone: text("owner_phone").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type UserWhatsappRow = typeof userWhatsappTable.$inferSelect;
