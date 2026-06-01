import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// One row per AI completion call. Token usage is attributed to the tenant
// OWNER (super_admin) — `userId` is always the owner id (resolved via
// resolveOwnerUserId at the call site), never an invited member's id, so a
// tenant's whole team rolls up to a single usage figure. `channelId` records
// which channel triggered the call (nullable, no FK — deleting a channel
// shouldn't erase the owner's historical usage; tenant deletion still cascades
// these rows away via the user_id FK).
//
// There is intentionally no historical backfill: this table only starts
// accruing once the capture code ships, so usage before that is unknowable.
export const aiUsageEventsTable = pgTable(
  "ai_usage_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id"),
    // "replit" (managed default) or the BYOK provider key (openai/gemini/openrouter).
    provider: text("provider").notNull().default("replit"),
    model: text("model").notNull().default(""),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("ai_usage_events_user_created_idx").on(t.userId, t.createdAt)]
);

export type AiUsageEventRow = typeof aiUsageEventsTable.$inferSelect;
