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

// Background AI jobs that hit the token hard-block (spec C2) are recorded here
// instead of being silently dropped: "di-defer dengan state". Each row marks a
// job that was held because the owner's quota was exhausted. The job's SOURCE
// item (cutoff log, scheduled follow-up, acr job) is left in its retriable state
// so the existing per-job scheduler re-runs it — WITH full rule re-validation —
// once quota returns. This table is the explicit state + audit trail; the
// resume reconciler stamps resumedAt/completed when the owner is unblocked.
export const aiDeferredJobsTable = pgTable(
  "ai_deferred_jobs",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Job family: "pipeline_cutoff" | "pipeline_followup" | "sales_followup" |
    // "acr_job". jobRef is the source entity id as text (cutoff log id, entry
    // id, opportunity/follow-up id, acr job id).
    jobType: text("job_type").notNull(),
    jobRef: text("job_ref").notNull(),
    // deferred → completed (re-ran ok) | cancelled (no longer relevant).
    status: text("status").notNull().default("deferred"),
    blockedAt: timestamp("blocked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One open row per (owner, jobType, jobRef): re-blocks update blockedAt
    // rather than piling up duplicates.
    uniqueIndex("ai_deferred_jobs_owner_type_ref_unique").on(
      t.ownerUserId,
      t.jobType,
      t.jobRef
    ),
    // Sweep "who has open deferred work" cheaply.
    index("ai_deferred_jobs_status_owner_idx").on(t.status, t.ownerUserId),
  ]
);

export type AiDeferredJobRow = typeof aiDeferredJobsTable.$inferSelect;
