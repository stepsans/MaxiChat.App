import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";

// ── Lead learning loop ───────────────────────────────────────────────────────
//
// Every manual lead-status correction the tenant makes (and every answer to a
// review request) is recorded here as a labeled training signal. The AI
// Pipeline reads recent rows back as few-shot "lessons" so its lead/not-lead
// judgement converges on THIS tenant's definition over time — "tambah lama
// tambah pintar". Pairs with [[ai-pipeline-role-detection]] (reverse-role).

export const leadFeedbackTable = pgTable(
  "lead_feedback",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    contactPhone: text("contact_phone").notNull(),
    chatId: integer("chat_id"),
    channelId: integer("channel_id"),
    // Transition the tenant made: unknown|lead|not_lead → lead|not_lead|unknown.
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    // Tenant-supplied rationale (free text) + an optional coarse category chip.
    reason: text("reason"),
    reasonCode: text("reason_code"),
    // What the AI thought at correction time — fuels conflict detection + lets
    // a lesson teach the model where it was wrong.
    aiConversationRole: text("ai_conversation_role"),
    aiScore: integer("ai_score"),
    contextSummary: text("context_summary"),
    // 'manual_edit' (combobox/bulk) | 'review_answer' (answered a popup).
    source: text("source").notNull().default("manual_edit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("lead_feedback_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("lead_feedback_owner_phone_idx").on(t.ownerUserId, t.contactPhone),
  ]
);

export type LeadFeedback = typeof leadFeedbackTable.$inferSelect;

// Pending clarification questions surfaced to the tenant on the "Review Lead"
// page. Created when the AI is uncertain (borderline score / unclear role) or
// when its verdict conflicts with a manual classification or a learned pattern.
export const leadReviewRequestsTable = pgTable(
  "lead_review_requests",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    contactPhone: text("contact_phone").notNull(),
    contactName: text("contact_name"),
    chatId: integer("chat_id"),
    channelId: integer("channel_id"),
    analysisId: integer("analysis_id"),
    // Why we are asking: 'uncertain' | 'conflict'.
    trigger: text("trigger").notNull(),
    question: text("question").notNull(),
    // The AI's best guess so the tenant can confirm/override in one tap.
    aiSuggestedStatus: text("ai_suggested_status"),
    aiScore: integer("ai_score"),
    aiConversationRole: text("ai_conversation_role"),
    contextSummary: text("context_summary"),
    // 'pending' | 'answered' | 'dismissed'.
    status: text("status").notNull().default("pending"),
    answeredStatus: text("answered_status"),
    answeredReason: text("answered_reason"),
    answeredByUserId: integer("answered_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [
    index("lead_review_owner_status_idx").on(t.ownerUserId, t.status),
    // At most one OPEN question per contact — avoids spamming the queue.
    uniqueIndex("lead_review_one_pending_per_contact")
      .on(t.ownerUserId, t.contactPhone)
      .where(sql`${t.status} = 'pending'`),
  ]
);

export type LeadReviewRequest = typeof leadReviewRequestsTable.$inferSelect;

// ── Teach-the-AI chat ────────────────────────────────────────────────────────
//
// The "Ajari AI" category of the Learning Inbox: a two-way chat where the tenant
// teaches the AI how to handle their business. Everything is keyed per owner so
// each tenant's preferences stay separate. `tenant_ai_memories` holds the
// durable facts the AI extracted from the chat; they are injected into the AI
// Pipeline analysis prompt so the model gets smarter per tenant over time.

export const tenantAiChatMessagesTable = pgTable(
  "tenant_ai_chat_messages",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tenant_ai_chat_owner_idx").on(t.ownerUserId, t.createdAt)]
);

export type TenantAiChatMessage = typeof tenantAiChatMessagesTable.$inferSelect;

export const tenantAiMemoriesTable = pgTable(
  "tenant_ai_memories",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    source: text("source").notNull().default("chat"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tenant_ai_memories_owner_idx").on(t.ownerUserId, t.archived, t.createdAt)]
);

export type TenantAiMemory = typeof tenantAiMemoriesTable.$inferSelect;
