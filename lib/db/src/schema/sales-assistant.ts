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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { chatsTable } from "./whatsapp";
import { channelsTable } from "./channels";

// ===========================================================================
// AI Sales Assistant (marketing name — internally an AI-assisted sales CRM).
// Enterprise-only substrate. Every table is keyed on the tenant OWNER's user
// id (`ownerUserId`) for multi-tenant isolation and so the existing
// self-delete cascade (users.parent_user_id) and tenant-reset flow can wipe
// them without leaving orphans. All money is whole-integer Rupiah.
// ===========================================================================

// A tenant's customizable sales pipeline stages (kanban columns). Seeded with
// seven defaults on first access (New Lead → Inquiry → Quotation Sent → Follow
// Up → Negotiation → Won → Lost); the tenant may later add/remove/reorder.
// Stages are CONFIGURATION (like products/flows), so tenant-reset KEEPS them.
export const pipelineStagesTable = pgTable(
  "pipeline_stages",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Ascending display order within the tenant's board.
    sortOrder: integer("sort_order").notNull().default(0),
    // Terminal markers. At most one Won and one Lost stage is meaningful, but
    // we don't DB-enforce that — the app keeps it sane. An opportunity in a
    // Won/Lost stage is closed and excluded from open-pipeline forecasts.
    isWon: boolean("is_won").notNull().default(false),
    isLost: boolean("is_lost").notNull().default(false),
    // Optional hex color for the kanban column header (later UI phase).
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
    index("pipeline_stages_owner_idx").on(t.ownerUserId, t.sortOrder),
    // A tenant can't have two stages with the same display name.
    uniqueIndex("pipeline_stages_owner_name_unique").on(t.ownerUserId, t.name),
  ]
);

// A sales opportunity (deal) detected from / attached to a chat. Exactly one
// opportunity per chat (unique chat_id). Lead score 0–100; estimated value is
// whole Rupiah. `assignedUserId` is the agent who owns the deal (RBAC scoping
// for the "agent sees only their own" rule); NULL = unassigned.
export const opportunitiesTable = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Agent who owns this deal. NULL = unassigned. SET NULL on user delete so
    // a removed team member doesn't drop the deal.
    assignedUserId: integer("assigned_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" }
    ),
    // Source chat — one opportunity per chat. CASCADE so wiping a chat (tenant
    // reset / chat delete) removes its opportunity.
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    // Source channel the deal originated on (WhatsApp/Telegram).
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    // Contact linkage. Mirrors the contact-level convention (owner + phone) so
    // a deal follows the number; `tg:<id>` for Telegram contacts.
    contactPhone: text("contact_phone").notNull(),
    contactName: text("contact_name"),
    // Current pipeline stage. SET NULL if a stage is deleted (later phase
    // reassigns); the deal survives stage deletion.
    stageId: integer("stage_id").references(() => pipelineStagesTable.id, {
      onDelete: "set null",
    }),
    // AI lead score 0–100 (0 = not yet scored).
    leadScore: integer("lead_score").notNull().default(0),
    // Free-text intent classification (e.g. "hot"/"warm"/"cold" or a category
    // label). NULL = not classified.
    intentCategory: text("intent_category"),
    // Estimated deal value in whole Rupiah. bigint (mode number) for headroom.
    estimatedValueIdr: bigint("estimated_value_idr", { mode: "number" })
      .notNull()
      .default(0),
    // Open / Won / Lost lifecycle. Stage flags drive board state; this is the
    // coarse status used by forecasts and filters.
    status: text("status").notNull().default("open"),
    // Who the deal is waiting on, e.g. "waiting_customer" / "waiting_us".
    // NULL = no explicit waiting state.
    waitingStatus: text("waiting_status"),
    // Products the contact has shown interest in (snapshot of names/codes).
    productInterest: jsonb("product_interest")
      .$type<string[]>()
      .notNull()
      .default([]),
    // AI-generated summary / notes about the deal.
    aiNotes: text("ai_notes"),
    // Last meaningful activity (message, stage change, follow-up). Drives
    // staleness / follow-up scheduling in later phases.
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
    // One opportunity per chat. A chat belongs to exactly one channel/owner,
    // so this global-unique is sufficient for the per-tenant invariant.
    uniqueIndex("opportunities_chat_unique").on(t.chatId),
    index("opportunities_owner_idx").on(t.ownerUserId),
    index("opportunities_owner_stage_idx").on(t.ownerUserId, t.stageId),
    index("opportunities_assigned_idx").on(t.assignedUserId),
  ]
);

// Scheduled follow-up messages for an opportunity. The auto-follow-up engine
// (later phase) generates up to three sequenced touches per deal.
export const opportunityFollowUpsTable = pgTable(
  "opportunity_follow_ups",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id")
      .notNull()
      .references(() => opportunitiesTable.id, { onDelete: "cascade" }),
    // Denormalized owner for tenant-scoped reads/wipes without a join.
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Touch number in the sequence (1–3).
    sequence: integer("sequence").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    // pending | sent | cancelled | skipped
    status: text("status").notNull().default("pending"),
    // The AI-drafted message body to send at `scheduledAt`.
    generatedMessage: text("generated_message"),
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

// Append-only audit trail of AI/sales activity (opportunity created, stage
// changed, scored, follow-up sent, etc.). Operational data → wiped by
// tenant-reset.
export const salesAuditEventsTable = pgTable(
  "sales_audit_events",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Optional deal the event relates to. CASCADE with the opportunity.
    opportunityId: integer("opportunity_id").references(
      () => opportunitiesTable.id,
      { onDelete: "cascade" }
    ),
    // Who triggered it; NULL for AI/system-generated events.
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // e.g. "opportunity_created" | "stage_changed" | "lead_scored" |
    // "follow_up_scheduled" | "follow_up_sent".
    eventType: text("event_type").notNull(),
    // Arbitrary structured payload (before/after stage, score delta, etc.).
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
  estimatedValueIdr: z.number().int().min(0).optional(),
  status: z.string().trim().max(20).optional(),
  waitingStatus: z.string().trim().max(40).nullable().optional(),
  productInterest: z.array(z.string().trim().max(120)).optional(),
  aiNotes: z.string().trim().max(4000).nullable().optional(),
}).omit({ id: true, ownerUserId: true, createdAt: true, updatedAt: true });

export type PipelineStageRow = typeof pipelineStagesTable.$inferSelect;
export type OpportunityRow = typeof opportunitiesTable.$inferSelect;
export type OpportunityFollowUpRow =
  typeof opportunityFollowUpsTable.$inferSelect;
export type SalesAuditEventRow = typeof salesAuditEventsTable.$inferSelect;
