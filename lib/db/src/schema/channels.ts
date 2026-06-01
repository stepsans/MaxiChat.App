import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Omnichannel pivot table. One row per "channel" a super-admin user has
// connected to MaxiChat: a WhatsApp number, an Instagram account, a Shopee
// store, etc. Replaces the old 1-user-1-WhatsApp assumption baked into
// `user_whatsapp` (which is kept temporarily as a legacy compatibility
// pointer during the multi-channel migration and dropped once all callers
// have moved over).
//
// Per-channel state (chats/messages/contacts/settings/flows) lives in tables
// that key off `channelId`. Shared resources (products/knowledge/shortcuts)
// live at the super-admin / `userId` level and use opt-in join tables to
// scope availability to specific channels.
//
// `kind` is intentionally a free-form text so we can roll out new integrations
// without a schema migration. The frontend gates which kinds are actually
// addable. Recognised values (Phase 1 implements only "whatsapp"):
//   whatsapp | instagram | facebook | tiktok_shop | shopee | webchat | line | telegram
//
// `status` values:
//   disconnected — created but never paired / explicitly logged out
//   connecting   — pairing in progress (e.g. QR shown, awaiting scan)
//   connected    — live (socket open / API authorised)
//   error        — last connect attempt failed; details in `metadata.lastError`
export const channelsTable = pgTable(
  "channels",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Human label shown in the switcher. Unique per user so the dropdown
    // entries are unambiguous ("WhatsApp 1" vs "WhatsApp 2").
    label: text("label").notNull(),
    // Hex colour (e.g. "#25D366") for the dot/badge in the switcher and on
    // any UI element that shows which channel a row came from.
    color: text("color").notNull().default("#25D366"),
    // Icon identifier — a key the frontend maps to a lucide/brand icon.
    // Defaults match the channel kind on create; user can override.
    icon: text("icon").notNull().default("whatsapp"),
    status: text("status").notNull().default("disconnected"),
    // WA-specific: the connected phone number (digits). Nullable because
    // non-WA channels don't have one. Globally unique (partial index below)
    // so the same WhatsApp number can't be paired to two channel rows.
    ownerPhone: text("owner_phone"),
    // WA-specific: the connected account's own WhatsApp profile/display name
    // (e.g. "SS"), captured from the socket on connect. Used to attribute who
    // "served" a chat (e.g. the Served By column on the sales-order Sheet
    // export). Nullable until the channel connects at least once.
    ownerName: text("owner_name"),
    // Kind-specific extras (e.g. Instagram page id, Shopee shop id,
    // last connection error). Schema enforced at the app layer per kind.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Labels are unique within a user's set of channels (no two "WhatsApp 1"
    // for the same super-admin), but two different users can both have a
    // channel called "WhatsApp 1" without colliding.
    channelsUserLabelUnique: uniqueIndex("channels_user_label_unique").on(
      t.userId,
      t.label
    ),
    // ownerPhone is globally unique across the table. The unique index
    // permits multiple NULLs (Postgres default) so non-WA channels are
    // unaffected. We rely on this to prevent the same WA number being
    // paired to two channels.
    channelsOwnerPhoneUnique: uniqueIndex("channels_owner_phone_unique").on(
      t.ownerPhone
    ),
  })
);

export type ChannelRow = typeof channelsTable.$inferSelect;
export type InsertChannel = typeof channelsTable.$inferInsert;
