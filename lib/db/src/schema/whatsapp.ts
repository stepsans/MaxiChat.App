import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const chatsTable = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),
    // Phone number of the WhatsApp account that owns this chat (the account
    // currently linked via QR pairing). Scoping every chat by ownerPhone is
    // what makes the dashboard a true per-account view: when a different
    // operator scans their own QR, they see only their own conversations,
    // not the previous account's history.
    ownerPhone: text("owner_phone").notNull(),
    phoneNumber: text("phone_number").notNull(),
    contactName: text("contact_name").notNull(),
    nickname: text("nickname"),
    status: text("status").notNull().default("ai_handled"),
    tag: text("tag").notNull().default("none"),
    isHumanTakeover: boolean("is_human_takeover").notNull().default(false),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    isLid: boolean("is_lid").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Composite uniqueness: the same conversation jid can exist independently
    // under each WhatsApp account. The old single-column unique on
    // phone_number is replaced by this composite to enforce isolation.
    chatsOwnerPhoneUnique: uniqueIndex("chats_owner_phone_number_unique").on(
      t.ownerPhone,
      t.phoneNumber
    ),
  })
);

export const insertChatSchema = createInsertSchema(chatsTable).omit({
  id: true,
  createdAt: true,
});

export type Chat = typeof chatsTable.$inferSelect;
export type InsertChat = z.infer<typeof insertChatSchema>;

export const chatMessagesTable = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    content: text("content").notNull(),
    isAiGenerated: boolean("is_ai_generated").notNull().default(false),
    mediaType: text("media_type"),
    mediaUrl: text("media_url"),
    mediaMimeType: text("media_mime_type"),
    mediaFilename: text("media_filename"),
    waMessageId: text("wa_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    waMessageIdUnique: uniqueIndex("chat_messages_wa_message_id_unique").on(t.waMessageId),
  })
);

export const insertChatMessageSchema = createInsertSchema(chatMessagesTable).omit({
  id: true,
  createdAt: true,
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

export const knowledgeTypesTable = pgTable("knowledge_types", {
  id: serial("id").primaryKey(),
  value: text("value").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type KnowledgeType = typeof knowledgeTypesTable.$inferSelect;

export const knowledgeTable = pgTable("knowledge_entries", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertKnowledgeSchema = createInsertSchema(knowledgeTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type KnowledgeEntry = typeof knowledgeTable.$inferSelect;
export type InsertKnowledge = z.infer<typeof insertKnowledgeSchema>;

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  systemPrompt: text("system_prompt").notNull(),
  autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(true),
  replyDelayMin: integer("reply_delay_min").notNull().default(1),
  replyDelayMax: integer("reply_delay_max").notNull().default(3),
  fallbackMessage: text("fallback_message").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Settings = typeof settingsTable.$inferSelect;

export const productsTable = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    price: integer("price").notNull(),
    priceSilver: integer("price_silver"),
    priceGold: integer("price_gold"),
    pricePlatinum: integer("price_platinum"),
    priceReseller: integer("price_reseller"),
    priceDistributor: integer("price_distributor"),
    imageUrl: text("image_url"),
    flyerUrl: text("flyer_url"),
    productUrl: text("product_url"),
    videoUrls: text("video_urls").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    productsCodeUnique: uniqueIndex("products_code_unique").on(t.code),
  })
);

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
