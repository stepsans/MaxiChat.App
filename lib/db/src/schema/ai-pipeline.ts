import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";
import { customerLabelsTable } from "./whatsapp";

// ===========================================================================
// AI Pipeline — automated chat analysis & sales pipeline feature.
// Every table is keyed on ownerUserId (tenant owner) for multi-tenant isolation.
// All money is whole-integer Rupiah.
// ===========================================================================

// Main AI Pipeline configuration per tenant.
export const aiPipelinesTable = pgTable(
  "ai_pipelines",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    // Minimum score to enter the pipeline (0-100).
    scoreThreshold: integer("score_threshold").notNull().default(70),
    autoFollowupEnabled: boolean("auto_followup_enabled").notNull().default(false),
    // Array of hours (e.g. ["24h", "48h", "72h"]).
    followupIntervals: jsonb("followup_intervals")
      .$type<string[]>()
      .notNull()
      .default(["24h", "48h", "72h"]),
    // Array of HH:MM strings (e.g. ["12:00", "23:59"]).
    cutoffTimes: jsonb("cutoff_times")
      .$type<string[]>()
      .notNull()
      .default(["12:00", "23:59"]),
    // Pipeline Health risk thresholds — mirrored from sales_assistant_settings
    // but scoped per pipeline so each can have independent sensitivity.
    staleDaysThreshold: integer("stale_days_threshold").notNull().default(14),
    highValueThresholdIdr: bigint("high_value_threshold_idr", { mode: "number" })
      .notNull()
      .default(0),
    customPrompt: text("custom_prompt"),
    promptVersion: integer("prompt_version").notNull().default(1),
    directionFilter: boolean("direction_filter").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("ai_pipelines_owner_idx").on(t.ownerUserId),
    uniqueIndex("ai_pipelines_owner_name_unique").on(t.ownerUserId, t.name),
  ]
);

// Channels monitored by a pipeline.
export const aiPipelineChannelsTable = pgTable(
  "ai_pipeline_channels",
  {
    id: serial("id").primaryKey(),
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_pipeline_channels_pipeline_idx").on(t.pipelineId),
    uniqueIndex("ai_pipeline_channels_unique").on(t.pipelineId, t.channelId),
  ]
);

// Labels whose contacts are excluded from analysis.
export const aiPipelineExcludeLabelsTable = pgTable(
  "ai_pipeline_exclude_labels",
  {
    id: serial("id").primaryKey(),
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => customerLabelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_pipeline_exclude_labels_pipeline_idx").on(t.pipelineId),
    uniqueIndex("ai_pipeline_exclude_labels_unique").on(t.pipelineId, t.labelId),
  ]
);

// AI analysis result per contact per channel per cut-off run.
export const aiPipelineAnalysesTable = pgTable(
  "ai_pipeline_analyses",
  {
    id: serial("id").primaryKey(),
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    contactPhone: text("contact_phone").notNull(),
    contactName: text("contact_name"),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    channelType: text("channel_type"),
    cutoffDatetime: timestamp("cutoff_datetime", { withTimezone: true }).notNull(),
    cutoffWindowStart: timestamp("cutoff_window_start", { withTimezone: true }).notNull(),
    cutoffWindowEnd: timestamp("cutoff_window_end", { withTimezone: true }).notNull(),
    score: integer("score").notNull().default(0),
    previousScore: integer("previous_score"),
    // Score breakdown: { buying_signal, urgency, engagement, commitment, product_fit, barrier_adjustment }
    scoreBreakdown: jsonb("score_breakdown")
      .$type<{
        buying_signal: number;
        urgency: number;
        engagement: number;
        commitment: number;
        product_fit: number;
        barrier_adjustment: number;
      }>()
      .default({
        buying_signal: 0,
        urgency: 0,
        engagement: 0,
        commitment: 0,
        product_fit: 0,
        barrier_adjustment: 0,
      }),
    status: text("status"),
    estimatedValue: bigint("estimated_value", { mode: "number" }),
    productInterest: text("product_interest"),
    recommendation: text("recommendation"),
    scoreReason: text("score_reason"),
    aiNotes: text("ai_notes"),
    // Hash of the main conversation topic for context-change detection.
    contextHash: text("context_hash"),
    enteredPipeline: boolean("entered_pipeline").notNull().default(false),
    pipelineEntryId: integer("pipeline_entry_id"),
    // Full raw AI response JSON.
    rawAnalysis: jsonb("raw_analysis").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_pipeline_analyses_pipeline_idx").on(t.pipelineId),
    index("ai_pipeline_analyses_owner_idx").on(t.ownerUserId),
    index("ai_pipeline_analyses_contact_channel_idx").on(t.contactPhone, t.channelId),
    index("ai_pipeline_analyses_cutoff_idx").on(t.pipelineId, t.cutoffDatetime),
  ]
);

// Pipeline entry created when a contact crosses the score threshold.
export const aiPipelineEntriesTable = pgTable(
  "ai_pipeline_entries",
  {
    id: serial("id").primaryKey(),
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => aiPipelineAnalysesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    contactPhone: text("contact_phone").notNull(),
    contactName: text("contact_name"),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    channelType: text("channel_type"),
    currentScore: integer("current_score").notNull(),
    estimatedValue: bigint("estimated_value", { mode: "number" }),
    productInterest: text("product_interest"),
    // 'new' | 'in_progress' | 'followup_sent' | 'replied' | 'closed_won' | 'closed_lost' | 'do_not_followup'
    status: text("status").notNull().default("new"),
    followupCount: integer("followup_count").notNull().default(0),
    lastFollowupAt: timestamp("last_followup_at", { withTimezone: true }),
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    doNotFollowup: boolean("do_not_followup").notNull().default(false),
    doNotFollowupReason: text("do_not_followup_reason"),
    doNotFollowupAt: timestamp("do_not_followup_at", { withTimezone: true }),
    // Array of { score, date, cutoff_window } objects.
    scoreHistory: jsonb("score_history")
      .$type<Array<{ score: number; date: string; cutoffWindow: string }>>()
      .notNull()
      .default([]),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("ai_pipeline_entries_pipeline_idx").on(t.pipelineId),
    index("ai_pipeline_entries_owner_idx").on(t.ownerUserId),
    index("ai_pipeline_entries_contact_channel_idx").on(t.contactPhone, t.channelId),
    index("ai_pipeline_entries_status_idx").on(t.pipelineId, t.status),
    index("ai_pipeline_entries_followup_idx").on(t.nextFollowupAt, t.status),
  ]
);

// Log of follow-up messages sent for a pipeline entry.
export const aiPipelineFollowupLogsTable = pgTable(
  "ai_pipeline_followup_logs",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => aiPipelineEntriesTable.id, { onDelete: "cascade" }),
    pipelineId: integer("pipeline_id").notNull(),
    contactPhone: text("contact_phone").notNull(),
    channelId: integer("channel_id").notNull(),
    followupNumber: integer("followup_number").notNull(),
    messageSent: text("message_sent").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    wasReplied: boolean("was_replied").notNull().default(false),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    // 'sent' | 'replied' | 'bounced' | 'stopped_by_customer'
    status: text("status").notNull().default("sent"),
  },
  (t) => [
    index("ai_pipeline_followup_logs_entry_idx").on(t.entryId),
    index("ai_pipeline_followup_logs_pipeline_idx").on(t.pipelineId),
  ]
);

// Audit log for each cut-off run (scheduler + manual trigger).
export const aiPipelineCutoffLogsTable = pgTable(
  "ai_pipeline_cutoff_logs",
  {
    id: serial("id").primaryKey(),
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    scheduledTime: timestamp("scheduled_time", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // 'pending' | 'running' | 'completed' | 'failed'
    status: text("status").notNull().default("pending"),
    contactsProcessed: integer("contacts_processed").notNull().default(0),
    contactsEnteredPipeline: integer("contacts_entered_pipeline").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_pipeline_cutoff_logs_pipeline_idx").on(t.pipelineId),
    index("ai_pipeline_cutoff_logs_status_time_idx").on(t.status, t.scheduledTime),
  ]
);

// Audit log for each AI prompt change.
export const aiPipelinePromptVersionsTable = pgTable(
  "ai_pipeline_prompt_versions",
  {
    id:          serial("id").primaryKey(),
    pipelineId:  integer("pipeline_id").notNull()
                   .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull()
                   .references(() => usersTable.id, { onDelete: "cascade" }),
    version:     integer("version").notNull(),
    promptText:  text("prompt_text").notNull(),
    changedBy:   integer("changed_by").notNull()
                   .references(() => usersTable.id),
    changedAt:   timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changeNote:  text("change_note"),
  },
  (t) => [
    index("ai_pipeline_prompt_versions_pipeline_idx").on(t.pipelineId, t.version),
  ]
);

// Visibility defaults per role per pipeline.
export const aiPipelineVisibilityTable = pgTable(
  "ai_pipeline_visibility",
  {
    id:          serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id").notNull()
                   .references(() => usersTable.id, { onDelete: "cascade" }),
    pipelineId:  integer("pipeline_id").notNull()
                   .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    role:        text("role").notNull(),
    canView:     boolean("can_view").notNull().default(false),
    canEdit:     boolean("can_edit").notNull().default(false),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_pipeline_visibility_unique").on(t.ownerUserId, t.pipelineId, t.role),
  ]
);

// Per-user override that wins over the role default.
export const aiPipelineUserVisibilityTable = pgTable(
  "ai_pipeline_user_visibility",
  {
    id:         serial("id").primaryKey(),
    userId:     integer("user_id").notNull()
                  .references(() => usersTable.id, { onDelete: "cascade" }),
    pipelineId: integer("pipeline_id").notNull()
                  .references(() => aiPipelinesTable.id, { onDelete: "cascade" }),
    canView:    boolean("can_view").notNull().default(false),
    canEdit:    boolean("can_edit").notNull().default(false),
    updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_pipeline_user_visibility_unique").on(t.userId, t.pipelineId),
  ]
);

// ---------------------------------------------------------------------------
// Zod insert schemas
// ---------------------------------------------------------------------------

export const insertAiPipelineSchema = createInsertSchema(aiPipelinesTable, {
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  scoreThreshold: z.number().int().min(0).max(100).optional(),
  followupIntervals: z.array(z.string()).optional(),
  cutoffTimes: z.array(z.string()).optional(),
}).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type AiPipelineRow = typeof aiPipelinesTable.$inferSelect;
export type AiPipelineChannelRow = typeof aiPipelineChannelsTable.$inferSelect;
export type AiPipelineExcludeLabelRow = typeof aiPipelineExcludeLabelsTable.$inferSelect;
export type AiPipelineAnalysisRow = typeof aiPipelineAnalysesTable.$inferSelect;
export type AiPipelineEntryRow = typeof aiPipelineEntriesTable.$inferSelect;
export type AiPipelineFollowupLogRow = typeof aiPipelineFollowupLogsTable.$inferSelect;
export type AiPipelineCutoffLogRow = typeof aiPipelineCutoffLogsTable.$inferSelect;
export type AiPipelinePromptVersionRow = typeof aiPipelinePromptVersionsTable.$inferSelect;
export type AiPipelineVisibilityRow = typeof aiPipelineVisibilityTable.$inferSelect;
export type AiPipelineUserVisibilityRow = typeof aiPipelineUserVisibilityTable.$inferSelect;
