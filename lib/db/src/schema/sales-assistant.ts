import {
  pgTable,
  serial,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { chatsTable } from "./whatsapp";
import { channelsTable } from "./channels";
import { productsTable } from "./whatsapp";

// ===========================================================================
// AI Sales Assistant (Enterprise-only). The marketing/user-facing name is
// always "AI Sales Assistant" — never "CRM".
// Enterprise-only substrate. Every table is keyed on the tenant OWNER's user
// id (`ownerUserId`) for multi-tenant isolation and so the existing
// self-delete cascade (users.parent_user_id) and tenant-reset flow can wipe
// them without leaving orphans. All money is whole-integer Rupiah.
// ===========================================================================

// A tenant-owned sales pipeline (e.g. "Pipeline Sales", "Pipeline Service").
// Multiple pipelines per tenant are allowed; each has its own stage columns.
// Seeded with two defaults (Sales + Service) on first access; the tenant may
// add, rename, or archive additional pipelines freely.
export const pipelinesTable = pgTable(
  "pipelines",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 'sales' | 'service' | 'custom' — controls AI routing and default stages.
    pipelineType: text("pipeline_type").notNull().default("sales"),
    // Hex color for the pipeline tab/badge in the UI.
    color: text("color").notNull().default("#6366f1"),
    // The pipeline the AI routes new opportunities to when no explicit match.
    isDefault: boolean("is_default").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("pipelines_owner_idx").on(t.ownerUserId, t.sortOrder),
    uniqueIndex("pipelines_owner_name_unique").on(t.ownerUserId, t.name),
  ]
);

// A stage (kanban column) within a specific pipeline. Seeded with defaults on
// first access; the tenant may add/remove/reorder per pipeline.
export const pipelineStagesTable = pgTable(
  "pipeline_stages",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Pipeline this stage belongs to. CASCADE: deleting a pipeline removes all
    // its stages (and SET NULLs any opportunities that were in those stages).
    pipelineId: integer("pipeline_id")
      .notNull()
      .references(() => pipelinesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isWon: boolean("is_won").notNull().default(false),
    isLost: boolean("is_lost").notNull().default(false),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("pipeline_stages_pipeline_idx").on(t.pipelineId, t.sortOrder),
    index("pipeline_stages_owner_idx").on(t.ownerUserId),
    // Stage names unique within a pipeline (not globally per owner).
    uniqueIndex("pipeline_stages_pipeline_name_unique").on(
      t.pipelineId,
      t.name
    ),
  ]
);

// A sales/service opportunity detected from or attached to a chat.
// Multiple opportunities per chat are allowed — one per distinct intent cluster
// (e.g. "mesin lem purchase" and "mesin laminasi service" from the same thread).
// Deduplication: (chat_id, intent_key) is unique when intent_key is not null;
// manual entries (intent_key IS NULL) are always allowed.
export const opportunitiesTable = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    assignedUserId: integer("assigned_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" }
    ),
    // Source chat. CASCADE so wiping a chat removes its opportunities.
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    // Source channel. CASCADE: removing a channel removes its opportunities.
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    // Pipeline this opportunity belongs to. SET NULL if pipeline is deleted
    // (opportunity survives, moves to "unsorted").
    pipelineId: integer("pipeline_id").references(() => pipelinesTable.id, {
      onDelete: "set null",
    }),
    // Current pipeline stage. SET NULL if the stage is deleted.
    stageId: integer("stage_id").references(() => pipelineStagesTable.id, {
      onDelete: "set null",
    }),
    // AI-generated slug that identifies the intent cluster within this chat.
    // Stable across re-analyses so the same topic upserts rather than duplicates.
    // Example: "mesin-lem-x200-purchase", "service-mesin-laminasi".
    // NULL for manually created opportunities (no dedup needed).
    intentKey: text("intent_key"),
    // 'purchase' | 'service' | 'renewal' | 'other'
    intentType: text("intent_type").notNull().default("purchase"),
    contactPhone: text("contact_phone").notNull(),
    contactName: text("contact_name"),
    leadScore: integer("lead_score").notNull().default(0),
    intentCategory: text("intent_category"),
    estimatedValueIdr: bigint("estimated_value_idr", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("open"),
    waitingStatus: text("waiting_status"),
    // Snapshot of product names/codes for this specific opportunity cluster.
    productInterest: jsonb("product_interest")
      .$type<string[]>()
      .notNull()
      .default([]),
    // AI evidence fields.
    scoreReason: text("score_reason"),
    aiNotes: text("ai_notes"),
    recommendation: text("recommendation"),
    // Message IDs that were in the analysis window — used to link back to the
    // specific messages in the chat view ("Buka Chat" scrolls to these).
    analyzedMessageIds: jsonb("analyzed_message_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    // Verbatim + signal quotes extracted by the AI for the evidence panel.
    // { positive: string[], negative: string[], verbatim: string[] }
    keyQuotes: jsonb("key_quotes")
      .$type<{
        positive: string[];
        negative: string[];
        verbatim: string[];
      }>()
      .notNull()
      .default({ positive: [], negative: [], verbatim: [] }),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Dedup: one opportunity per (chat, intent cluster). Manual entries
    // (intent_key IS NULL) are exempt — allow multiple manual per chat.
    uniqueIndex("opportunities_chat_intent_unique").on(
      t.chatId,
      t.intentKey
    ).where(sql`${t.intentKey} IS NOT NULL`),
    index("opportunities_owner_idx").on(t.ownerUserId),
    index("opportunities_pipeline_stage_idx").on(t.pipelineId, t.stageId),
    index("opportunities_owner_stage_idx").on(t.ownerUserId, t.stageId),
    index("opportunities_assigned_idx").on(t.assignedUserId),
    index("opportunities_chat_idx").on(t.chatId),
  ]
);

// Products linked to a specific opportunity. Many-to-many: one opportunity can
// cover multiple products; one product can appear in many opportunities.
// product_id is nullable because the customer may mention a product not in
// the catalog — we always store the name for display.
export const opportunityProductsTable = pgTable(
  "opportunity_products",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    // Nullable: product may not be in the catalog (customer mentioned by name).
    productId: integer("product_id").references(() => productsTable.id, {
      onDelete: "set null",
    }),
    // Always store the name so the card still renders if the product is deleted.
    productName: text("product_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("opportunity_products_opp_idx").on(t.opportunityId),
    index("opportunity_products_product_idx").on(t.productId),
  ]
);

// Scheduled follow-up messages for an opportunity.
export const opportunityFollowUpsTable = pgTable(
  "opportunity_follow_ups",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    generatedMessage: text("generated_message"),
    manualDraft: boolean("manual_draft").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("opportunity_follow_ups_opp_seq_unique").on(
      t.opportunityId,
      t.sequence
    ),
    index("opportunity_follow_ups_owner_idx").on(t.ownerUserId),
    index("opportunity_follow_ups_due_idx").on(t.status, t.scheduledAt),
  ]
);

// Append-only audit trail of AI/sales activity.
export const salesAuditEventsTable = pgTable(
  "sales_audit_events",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    opportunityId: integer("opportunity_id").references(
      () => opportunitiesTable.id,
      { onDelete: "cascade" }
    ),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sales_audit_events_owner_idx").on(t.ownerUserId, t.createdAt),
    index("sales_audit_events_opp_idx").on(t.opportunityId),
  ]
);

// Latest AI analysis ("AI Sales Insight") for a chat. One row per chat,
// refreshed on every detection run. Exists even when no opportunity has been
// created (toggle OFF = recommend only).
export const salesInsightsTable = pgTable(
  "sales_insights",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    contactPhone: text("contact_phone").notNull(),
    leadScore: integer("lead_score").notNull().default(0),
    intentCategory: text("intent_category"),
    estimatedValueIdr: bigint("estimated_value_idr", { mode: "number" })
      .notNull()
      .default(0),
    productInterest: jsonb("product_interest")
      .$type<string[]>()
      .notNull()
      .default([]),
    scoreReason: text("score_reason"),
    aiNotes: text("ai_notes"),
    recommendation: text("recommendation"),
    waitingStatus: text("waiting_status"),
    // Raw AI-detected opportunity candidates from the latest analysis run.
    // Stored so the sidebar can show per-candidate "Buat" buttons even when
    // auto-create is OFF (without this, candidates are lost after analysis).
    detectedCandidates: jsonb("detected_candidates")
      .$type<Array<{
        intentKey: string;
        intentType: string;
        pipelineType: string;
        products: string[];
        intentCategory: string;
        leadScore: number;
        estimatedValueIdr: number;
        scoreReason: string | null;
        aiNotes: string | null;
        recommendation: string | null;
      }>>()
      .notNull()
      .default([]),
    lastMessageId: integer("last_message_id"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("sales_insights_chat_unique").on(t.chatId),
    index("sales_insights_owner_idx").on(t.ownerUserId),
  ]
);

// Per-tenant AI Sales Assistant configuration.
export const salesAssistantSettingsTable = pgTable(
  "sales_assistant_settings",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    autoCreateEnabled: boolean("auto_create_enabled").notNull().default(false),
    autoCreateThreshold: integer("auto_create_threshold").notNull().default(70),
    staleDaysThreshold: integer("stale_days_threshold").notNull().default(14),
    highValueThresholdIdr: bigint("high_value_threshold_idr", { mode: "number" })
      .notNull()
      .default(0),
    autoFollowUpEnabled: boolean("auto_follow_up_enabled")
      .notNull()
      .default(false),
    followUpIntervalHours: integer("follow_up_interval_hours")
      .notNull()
      .default(48),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("sales_assistant_settings_owner_unique").on(t.ownerUserId),
  ]
);

// ---------------------------------------------------------------------------
// Zod insert schemas
// ---------------------------------------------------------------------------

export const insertPipelineSchema = createInsertSchema(pipelinesTable, {
  name: z.string().trim().min(1).max(80),
  pipelineType: z.enum(["sales", "service", "custom"]).optional(),
  color: z.string().trim().max(20).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

export const insertPipelineStageSchema = createInsertSchema(
  pipelineStagesTable,
  {
    name: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).optional(),
    color: z.string().trim().max(20).nullable().optional(),
  }
).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

export const insertOpportunitySchema = createInsertSchema(opportunitiesTable, {
  contactPhone: z.string().trim().min(1).max(64),
  contactName: z.string().trim().max(120).nullable().optional(),
  leadScore: z.number().int().min(0).max(100).optional(),
  intentCategory: z.string().trim().max(40).nullable().optional(),
  intentType: z.enum(["purchase", "service", "renewal", "other"]).optional(),
  estimatedValueIdr: z.number().int().min(0).optional(),
  status: z.string().trim().max(20).optional(),
  waitingStatus: z.string().trim().max(40).nullable().optional(),
  productInterest: z.array(z.string().trim().max(120)).optional(),
  aiNotes: z.string().trim().max(4000).nullable().optional(),
  scoreReason: z.string().trim().max(4000).nullable().optional(),
  recommendation: z.string().trim().max(2000).nullable().optional(),
}).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

export const insertSalesInsightSchema = createInsertSchema(salesInsightsTable, {
  contactPhone: z.string().trim().min(1).max(64),
  leadScore: z.number().int().min(0).max(100).optional(),
  intentCategory: z.string().trim().max(40).nullable().optional(),
  estimatedValueIdr: z.number().int().min(0).optional(),
  productInterest: z.array(z.string().trim().max(120)).optional(),
  scoreReason: z.string().trim().max(4000).nullable().optional(),
  aiNotes: z.string().trim().max(4000).nullable().optional(),
  recommendation: z.string().trim().max(2000).nullable().optional(),
  waitingStatus: z.string().trim().max(40).nullable().optional(),
  lastMessageId: z.number().int().nullable().optional(),
}).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

export const insertSalesAssistantSettingsSchema = createInsertSchema(
  salesAssistantSettingsTable,
  {
    autoCreateEnabled: z.boolean().optional(),
    autoCreateThreshold: z.number().int().min(0).max(100).optional(),
    staleDaysThreshold: z.number().int().min(1).max(365).optional(),
    highValueThresholdIdr: z.number().int().min(0).optional(),
    autoFollowUpEnabled: z.boolean().optional(),
    followUpIntervalHours: z.number().int().min(1).max(8760).optional(),
  }
).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type PipelineRow = typeof pipelinesTable.$inferSelect;
export type PipelineStageRow = typeof pipelineStagesTable.$inferSelect;
export type OpportunityRow = typeof opportunitiesTable.$inferSelect;
export type OpportunityProductRow = typeof opportunityProductsTable.$inferSelect;
export type OpportunityFollowUpRow = typeof opportunityFollowUpsTable.$inferSelect;
export type SalesAuditEventRow = typeof salesAuditEventsTable.$inferSelect;
export type SalesInsightRow = typeof salesInsightsTable.$inferSelect;
export type SalesAssistantSettingsRow = typeof salesAssistantSettingsTable.$inferSelect;
