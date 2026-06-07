import {
  pgTable,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./channels";
import {
  productsTable,
  knowledgeTable,
  textShortcutsTable,
} from "./whatsapp";
import { chatbotFlowsTable } from "./chatbot";

// Opt-in channel scoping for super-admin-shared resources (products,
// knowledge, shortcuts). Semantics:
//   - NO rows in the join table for a given resource id  → resource is
//     "global" within the super-admin's account and available to ALL their
//     channels.
//   - ONE OR MORE rows                                    → resource is
//     scoped only to the listed channels; other channels of the same user
//     do not see it.
//
// This lets a super-admin maintain a single catalog/knowledge base and
// progressively assign specific items to specific channels (e.g. "this
// promo product only for the Instagram channel") without duplicating rows.
//
// FKs cascade on channel delete so disconnecting a channel cleans up its
// assignments automatically. The owning resource id is also cascade-deleted.

export const productChannelsTable = pgTable(
  "product_channels",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.productId, t.channelId] }),
  })
);

export const knowledgeEntryChannelsTable = pgTable(
  "knowledge_entry_channels",
  {
    knowledgeId: integer("knowledge_id")
      .notNull()
      .references(() => knowledgeTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.knowledgeId, t.channelId] }),
  })
);

export const textShortcutChannelsTable = pgTable(
  "text_shortcut_channels",
  {
    shortcutId: integer("shortcut_id")
      .notNull()
      .references(() => textShortcutsTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shortcutId, t.channelId] }),
  })
);

// Chatbot flows are owner-scoped and assigned to channels here. Same
// semantics as the resource joins above: NO rows = global (the flow may run
// on every channel the owner has); ONE OR MORE rows = scoped to those
// channels only.
export const chatbotFlowChannelsTable = pgTable(
  "chatbot_flow_channels",
  {
    flowId: integer("flow_id")
      .notNull()
      .references(() => chatbotFlowsTable.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.flowId, t.channelId] }),
  })
);

export type ProductChannelRow = typeof productChannelsTable.$inferSelect;
export type KnowledgeEntryChannelRow =
  typeof knowledgeEntryChannelsTable.$inferSelect;
export type TextShortcutChannelRow =
  typeof textShortcutChannelsTable.$inferSelect;
export type ChatbotFlowChannelRow =
  typeof chatbotFlowChannelsTable.$inferSelect;
