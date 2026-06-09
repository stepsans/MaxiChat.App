import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// OTP verification table for WhatsApp numbers.
// Used during: (1) new signup — verify WA number, (2) future WA login.
// OTP is NEVER stored plaintext — stored as a SHA-256 hash. One number may
// have several rows (one per request) but only the latest is valid
// (check expires_at + verified_at IS NULL).
export const waOtpTable = pgTable(
  "wa_otp_requests",
  {
    id: serial("id").primaryKey(),
    // WA number in E.164 format without the + sign, e.g. 6281234567890.
    phone: text("phone").notNull(),
    // SHA-256 hash of the 6-digit OTP. Never store OTP plaintext.
    otpHash: text("otp_hash").notNull(),
    // Why the OTP was created. 'signup' = verification at registration.
    purpose: text("purpose").notNull().default("signup"),
    // How many times the user mis-entered the OTP. After >= 5 the row is
    // locked and a fresh OTP must be requested.
    attemptCount: integer("attempt_count").notNull().default(0),
    // How many times the user resent the OTP in one session.
    // Max 3 resends per number per hour.
    resendCount: integer("resend_count").notNull().default(0),
    // OTP expires 5 minutes after created_at.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set when the OTP is successfully verified. Verified rows are single-use.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // Optional FK to the user that requested the OTP (if a user row exists).
    // Null for the signup flow (no user yet when the OTP is requested).
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    // IP address of the requester, for extra rate limiting.
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wa_otp_phone_idx").on(t.phone),
    index("wa_otp_user_idx").on(t.userId),
  ]
);

export type WaOtpRow = typeof waOtpTable.$inferSelect;
