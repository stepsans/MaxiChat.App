import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// A flattened snapshot of the user's Google Contacts (People API), pulled when
// a googleContactsApi credential is connected and synced. We only keep what we
// need to map a phone number → saved name: the contact's display name, the
// normalized digits of one of their phone numbers, and a `matchKey` (the last
// few digits) used for lookups that are robust to 0/62/+62 prefix differences.
// One row per (user, phone number).
export const googleContactsTable = pgTable(
  "google_contacts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Saved contact display name (People API person.names[0].displayName).
    name: text("name").notNull(),
    // Full normalized digits of the phone number (no '+', no separators).
    phoneDigits: text("phone_digits").notNull(),
    // Suffix used for prefix-insensitive matching (last up to 9 digits).
    matchKey: text("match_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    googleContactsUserPhoneUnique: uniqueIndex(
      "google_contacts_user_phone_unique"
    ).on(t.userId, t.phoneDigits),
    googleContactsUserMatchKeyIdx: index("google_contacts_user_match_key_idx").on(
      t.userId,
      t.matchKey
    ),
  })
);

export type GoogleContact = typeof googleContactsTable.$inferSelect;
