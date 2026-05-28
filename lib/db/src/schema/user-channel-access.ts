import {
  pgTable,
  serial,
  integer,
  uniqueIndex,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";

// Per-user allow-list of channels this user can SEE CHATS IN. Scope is
// intentionally narrow: this table only gates chat visibility (chat list,
// chat detail, chat mutations) and the channel switcher. Other channel-
// scoped surfaces (flows, statuses, analytics, knowledge, products) stay
// team-wide and are unaffected.
//
// Semantics (resolved in lib/user-channel-access.ts):
//   * super_admin  → ALWAYS sees every channel owned by their tenant; rows
//                    here are ignored. The owner cannot lock themselves out.
//   * other roles  → DENY BY DEFAULT. A user with zero rows sees no chats
//                    and an empty channel switcher. The super_admin must
//                    explicitly grant channels via the Permission per User
//                    editor. On rollout we backfill existing supervisors
//                    and agents with rows for every existing channel so no
//                    one suddenly loses access.
//
// ON DELETE CASCADE on both FKs so leaving the team or removing a channel
// drops the grant automatically.
export const userChannelAccessTable = pgTable(
  "user_channel_access",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqByUserChannel: uniqueIndex("user_channel_access_user_channel_key").on(
      t.userId,
      t.channelId
    ),
  })
);

export type UserChannelAccessRow = typeof userChannelAccessTable.$inferSelect;
