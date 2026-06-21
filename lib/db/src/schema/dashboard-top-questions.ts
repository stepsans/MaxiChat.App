import {
  pgTable,
  serial,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Cached "Pertanyaan tersering" (spec A.3 / 3.4): the AI clusters recent inbound
// customer messages into top intents on a schedule (NOT real-time, to save
// tokens). One latest snapshot per owner; the scheduler upserts on owner_user_id.
export interface TopQuestion {
  intent: string;
  count: number;
}

export const dashboardTopQuestionsTable = pgTable(
  "dashboard_top_questions",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    payload: jsonb("payload")
      .notNull()
      .$type<{ questions: TopQuestion[] }>()
      .default({ questions: [] }),
    sampleCount: integer("sample_count").notNull().default(0),
    windowDays: integer("window_days").notNull().default(30),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("dashboard_top_questions_owner_unique").on(t.ownerUserId)]
);

export type DashboardTopQuestionsRow = typeof dashboardTopQuestionsTable.$inferSelect;
