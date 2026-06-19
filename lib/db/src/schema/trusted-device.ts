import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Perangkat tepercaya untuk skip OTP login (passwordless "remember me").
// Token mentah TIDAK disimpan — hanya SHA-256 hash (sama seperti auth_tokens).
// Web: token disimpan di cookie httpOnly terpisah (mc_td). Mobile: dikembalikan
// ke client, disimpan di SecureStore, dikirim sebagai header X-Trusted-Device.
// Token dirotasi tiap kali dipakai (sliding window 30 hari) dan bisa dicabut.
export const trustedDevicesTable = pgTable(
  "trusted_devices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    // Label perangkat untuk ditampilkan di daftar (mis. "Chrome · Windows").
    label: text("label"),
    // Disimpan untuk tampilan & soft-check; TIDAK di-hard-bind (IP mobile roaming).
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Diisi saat dicabut (oleh user sendiri, owner, atau saat akun di-disable).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("trusted_devices_user_idx").on(t.userId)]
);

export type TrustedDeviceRow = typeof trustedDevicesTable.$inferSelect;
