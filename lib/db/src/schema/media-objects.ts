import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";

// Ledger of every file stored in Object Storage, keyed to the tenant OWNER.
// This is the source of truth for:
//   - per-tenant storage usage  (SUM(size_bytes) WHERE owner_user_id = ?)
//   - data retention            (delete rows + objects older than a cutoff)
//   - tenant reset / deletion   (enumerate + delete every object for an owner)
//
// Every object lives under the key prefix `tenants/<ownerUserId>/...` in the
// bucket, so a tenant's footprint is both measurable and isolable. `objectPath`
// is the normalized `/objects/<entityId>` path used by the serving route.
export const mediaObjectsTable = pgTable(
  "media_objects",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Channel the file belongs to, when applicable (chat/status media). Null for
    // owner-level assets (product images, generated docs). SET NULL so deleting
    // a channel never strands the storage-usage accounting.
    channelId: integer("channel_id").references(() => channelsTable.id, {
      onDelete: "set null",
    }),
    // Normalized object path: "/objects/tenants/<owner>/<kind>/<uuid><ext>".
    objectPath: text("object_path").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    // Coarse category for retention/debugging: chat | status | product | flow |
    // inbound | document | other.
    kind: text("kind"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("media_objects_owner_idx").on(t.ownerUserId)]
);

export type MediaObjectRow = typeof mediaObjectsTable.$inferSelect;
