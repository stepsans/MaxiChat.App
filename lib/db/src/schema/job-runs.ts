import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Scheduler heartbeat for the Dashboard "System Health" strip (spec A.9 / 2.7).
// Every scheduled job writes ONE row when it finishes (ok/failed) — or flips a
// 'running' row — so the dashboard can show lastRun + status + error without each
// scheduler inventing its own reporting. AI Pipeline already has
// `ai_pipeline_cutoff_logs`; this table covers the rest (ai_chat_report,
// agent_quality, crm_followup_poller, …) and can also mirror cutoff for a single
// unified read.
export const jobRunsTable = pgTable(
  "job_runs",
  {
    id: serial("id").primaryKey(),
    // Nullable: global jobs (not tenant-scoped) leave this null.
    ownerUserId: integer("owner_user_id"),
    // Stable job identifier, e.g. 'ai_chat_report' | 'agent_quality' |
    // 'crm_followup_poller' | 'ai_pipeline_cutoff'.
    jobName: text("job_name").notNull(),
    // 'ok' | 'failed' | 'running'.
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("job_runs_name_created_idx").on(t.jobName, t.createdAt),
    index("job_runs_owner_idx").on(t.ownerUserId, t.jobName, t.createdAt),
  ]
);

export type JobRunRow = typeof jobRunsTable.$inferSelect;
