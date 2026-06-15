import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// ===========================================================================
// Laporan & Jadwal — unified report scheduling + AI insight cache.
//
// Supersedes the standalone ACR auto-schedule surface: a single "Jadwal
// Laporan" lets a tenant pick report content (KPI summary / AI analysis /
// chat history / trend), recipients (email), and a cadence (once / daily /
// weekly / monthly). A 60s poller (report-schedule-runner.ts) sends due
// reports and records every attempt in report_schedule_logs.
//
// Convention note: list columns use native Postgres arrays (text[]/integer[])
// to match the ACR schema; report_ai_cache.content is genuinely structured so
// it stays jsonb.
// ===========================================================================

// One report-schedule configuration owned by a tenant (super_admin owner).
export const reportSchedulesTable = pgTable(
  "report_schedules",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),

    // Which report sections to include: 'kpi' | 'ai_analysis' | 'chat_history' | 'trend'.
    contentTypes: text("content_types").array().notNull().default([]),

    // 'once' | 'daily' | 'weekly' | 'monthly'.
    frequency: varchar("frequency", { length: 50 }).notNull().default("once"),
    // For weekly: ISO weekday numbers [1..7] (1 = Monday). Null otherwise.
    recurrenceDays: integer("recurrence_days").array(),
    // Send time HH:mm in the schedule's timezone.
    sendTime: varchar("send_time", { length: 5 }).notNull().default("07:00"),
    timezone: varchar("timezone", { length: 100 }).notNull().default("Asia/Jakarta"),

    // Recipient email addresses.
    recipientEmails: text("recipient_emails").array().notNull().default([]),

    isActive: boolean("is_active").notNull().default(true),

    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    // 'sent' | 'failed' | null.
    lastSendStatus: varchar("last_send_status", { length: 50 }),
    lastSendError: text("last_send_error"),

    // Next fire time (UTC). Null for a one-time schedule that has been sent.
    nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_report_schedules_owner").on(t.ownerUserId),
    index("idx_report_schedules_next_scheduled").on(t.nextScheduledAt),
  ],
);

// One delivery attempt for a report schedule (scheduler or manual send-now).
export const reportScheduleLogsTable = pgTable(
  "report_schedule_logs",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => reportSchedulesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull(),
    // 'scheduler' | 'manual'.
    triggeredBy: varchar("triggered_by", { length: 50 }).notNull().default("scheduler"),
    // 'pending' | 'sent' | 'failed'.
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    recipientEmails: text("recipient_emails").array().notNull().default([]),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_report_schedule_logs_schedule").on(t.scheduleId)],
);

// Structured AI-insight payload cached per (owner, cache_key) with a TTL.
export type ReportAiCacheContent = Record<string, unknown>;

// Cached AI-insight results (narrative / anomaly / kb_recommendations),
// refreshed when expires_at passes.
export const reportAiCacheTable = pgTable(
  "report_ai_cache",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // 'anomaly_detection' | 'insight_narrative' | 'kb_recommendations' (may be period-suffixed).
    cacheKey: varchar("cache_key", { length: 255 }).notNull(),
    content: jsonb("content").$type<ReportAiCacheContent>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_report_ai_cache_owner_key").on(t.ownerUserId, t.cacheKey),
    index("idx_report_ai_cache_expires").on(t.expiresAt),
  ],
);

export type ReportScheduleRow = typeof reportSchedulesTable.$inferSelect;
export type ReportScheduleLogRow = typeof reportScheduleLogsTable.$inferSelect;
export type ReportAiCacheRow = typeof reportAiCacheTable.$inferSelect;
