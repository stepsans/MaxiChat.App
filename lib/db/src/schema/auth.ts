import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

// Application users. Self-signup is allowed but new accounts land in
// `status = "pending"` and cannot sign in until a super admin approves them.
// The fixed seed users (Stephen + the two test accounts) are inserted at
// boot in `status = "active"`. Stephen is the sole `role = "admin"` and is
// the only account that can call the /admin/* endpoints.
//
// status values: "pending" (awaiting admin approval), "active" (can log in),
// "disabled" (sign-in blocked, data preserved).
// role values:   "user" (default), "admin" (super admin).
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
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
