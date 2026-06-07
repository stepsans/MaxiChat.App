import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Opaque bearer tokens issued to the mobile app. The mobile client has no
// cookie jar, so instead of express-session it authenticates with
// `Authorization: Bearer <token>`. We store only a SHA-256 hash of the token
// (never the raw value) so a DB leak can't be replayed. `getSessionUserId`
// resolves a valid, unexpired token to its user id transparently; the web
// cookie-session path is untouched.
export const authTokensTable = pgTable("auth_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  // Optional free-text label (e.g. device name) for future token management.
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  // NULL = never expires. We default to a long-lived token (90 days) issued
  // at login and refreshed on use is intentionally avoided to keep reads cheap.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// One row per (user, device) Expo push token. Used to deliver push
// notifications for incoming messages to the mobile app. `token` is the
// ExponentPushToken[...] string; it's globally unique so re-registering the
// same physical device upserts rather than duplicating.
export const deviceTokensTable = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  platform: text("platform"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type AuthTokenRow = typeof authTokensTable.$inferSelect;
export type DeviceTokenRow = typeof deviceTokensTable.$inferSelect;
