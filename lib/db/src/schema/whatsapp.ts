import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const chatsTable = pgTable("chats", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  contactName: text("contact_name").notNull(),
  status: text("status").notNull().default("ai_handled"),
  tag: text("tag").notNull().default("none"),
  isHumanTakeover: boolean("is_human_takeover").notNull().default(false),
  lastMessage: text("last_message"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  unreadCount: integer("unread_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertChatSchema = createInsertSchema(chatsTable).omit({
  id: true,
  createdAt: true,
});

export type Chat = typeof chatsTable.$inferSelect;
export type InsertChat = z.infer<typeof insertChatSchema>;

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chatsTable.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  content: text("content").notNull(),
  isAiGenerated: boolean("is_ai_generated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertChatMessageSchema = createInsertSchema(chatMessagesTable).omit({
  id: true,
  createdAt: true,
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

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
