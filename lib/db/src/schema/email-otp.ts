import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const emailOtpTable = pgTable("email_otps", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  otpHash: text("otp_hash").notNull(),
  purpose: text("purpose").notNull().default("login"),
  attemptCount: integer("attempt_count").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("email_otp_email_idx").on(t.email),
  index("email_otp_user_idx").on(t.userId),
]);

export type EmailOtpRow = typeof emailOtpTable.$inferSelect;
