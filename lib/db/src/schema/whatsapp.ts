import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";

export const chatsTable = pgTable(
  "chats",
  {
    id: serial("id").primaryKey(),
    // Multi-channel pivot. Every chat belongs to exactly one channel; the
    // dashboard's "All channels" view aggregates across the user's
    // permitted channels via channel_assignments.
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    contactName: text("contact_name").notNull(),
    nickname: text("nickname"),
    // Free-text company/organisation the contact belongs to. Shown and
    // editable in the chat Info sidebar (Tab 1). Null = not set.
    company: text("company"),
    // Customer code (kode customer), typed manually in the chat Info tab and
    // exported onto the sales-order Google Sheet rows. Null = not set.
    customerCode: text("customer_code"),
    status: text("status").notNull().default("ai_handled"),
    tag: text("tag").notNull().default("none"),
    isHumanTakeover: boolean("is_human_takeover").notNull().default(false),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    isLid: boolean("is_lid").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    unreadCount: integer("unread_count").notNull().default(0),
    profilePicUrl: text("profile_pic_url"),
    profilePicCheckedAt: timestamp("profile_pic_checked_at", { withTimezone: true }),
    // When a supervisor/super_admin assigns this chat to a specific agent user
    // (users.id), only that agent + supervisors + the super_admin can see it
    // in their /chats list. NULL = unassigned (visible to super_admin +
    // supervisors only). Plain integer (no FK) to avoid a cross-schema
    // circular reference; the chats route validates the user belongs to the
    // same owner before writing.
    assignedUserId: integer("assigned_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" }
    ),
    // KPI tracking. Set the first time the chat is assigned to an agent
    // (manually or via round-robin) and never updated afterward, so reports
    // can compute "time-to-first-assign". firstAgentReplyAt is set on the
    // first outbound message authored by the assigned agent — combined with
    // firstAssignedAt this gives "first-response-time" per agent.
    firstAssignedAt: timestamp("first_assigned_at", { withTimezone: true }),
    firstAgentReplyAt: timestamp("first_agent_reply_at", { withTimezone: true }),
    // Runtime chatbot-flow state. `{ flowId: number, currentNodeId: string }`
    // when the chat is currently waiting on a reply inside a flow; null when
    // not in a flow (AI handles the chat normally).
    flowState: jsonb("flow_state"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Composite uniqueness: the same conversation jid can exist independently
    // under each channel.
    chatsChannelPhoneUnique: uniqueIndex("chats_channel_phone_number_unique").on(
      t.channelId,
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

// Customer labels ("Label Customer") — colored tags a super_admin defines per
// business (owner user) in Settings, e.g. "High Risk Cust", "Follow Up". A
// contact can carry MANY labels (see chatLabelsTable). Owner-scoped by userId
// (not ownerPhone) so a phone reassignment never leaks another tenant's labels.
export const customerLabelsTable = pgTable(
  "customer_labels",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Hex color like "#ef4444" used for the chip background in the UI.
    color: text("color").notNull().default("#64748b"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerLabelsOwnerNameUnique: uniqueIndex(
      "customer_labels_owner_name_unique"
    ).on(t.ownerUserId, t.name),
  })
);

export const insertCustomerLabelSchema = createInsertSchema(customerLabelsTable).omit({
  id: true,
  createdAt: true,
});

export type CustomerLabel = typeof customerLabelsTable.$inferSelect;
export type InsertCustomerLabel = z.infer<typeof insertCustomerLabelSchema>;

// Many-to-many join: which labels are attached to which chat/contact.
export const chatLabelsTable = pgTable(
  "chat_labels",
  {
    chatId: integer("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => customerLabelsTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    chatLabelsPk: uniqueIndex("chat_labels_chat_label_unique").on(
      t.chatId,
      t.labelId
    ),
    chatLabelsLabelIdx: index("chat_labels_label_idx").on(t.labelId),
  })
);

export type ChatLabel = typeof chatLabelsTable.$inferSelect;

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
    // Sender identity for inbound group messages so the UI can show
    // "who said what". Null for 1:1 chats (the chat header already
    // identifies the speaker) and for outbound messages.
    //   senderJid          — full JID like "62…@s.whatsapp.net" or "…@lid"
    //   senderPhoneDigits  — digits portion (LID or real phone), used as
    //                        the lookup key when resolving @mentions
    //   senderName         — pushName captured at receive time
    senderJid: text("sender_jid"),
    senderPhoneDigits: text("sender_phone_digits"),
    senderName: text("sender_name"),
    // Digits of every JID referenced in this message's mentions
    // (contextInfo.mentionedJid stripped to digits). Lets the UI swap
    // raw "@628…" / "@<lid>" tokens in the body for the mentioned
    // contact's nickname.
    mentionedPhoneDigits: text("mentioned_phone_digits").array(),
    // MaxiChat-internal "star" flag. WhatsApp's own starred messages live on
    // the phone and don't sync over Baileys, so this is dashboard-local: an
    // operator can star a message inside MaxiChat to bookmark it.
    isStarred: boolean("is_starred").notNull().default(false),
    // Forwarding metadata, mirroring WhatsApp's contextInfo. isForwarded marks
    // a message as forwarded (inbound: detected from the channel; outbound: set
    // when an operator forwards via MaxiChat). forwardingScore is WhatsApp's
    // forward count — >=1 shows the "Diteruskan" tag, >=4 shows "Diteruskan
    // berkali-kali". Telegram has no count so forwards land with score 0.
    isForwarded: boolean("is_forwarded").notNull().default(false),
    forwardingScore: integer("forwarding_score").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    waMessageIdUnique: uniqueIndex("chat_messages_wa_message_id_unique").on(t.waMessageId),
    // Conversation loads filter by chat_id and page by (created_at, id) — this
    // composite index turns that from a full table scan into an index range
    // scan, which matters a lot for large group chats (tens of thousands of
    // messages).
    chatIdCreatedAtIdx: index("chat_messages_chat_id_created_at_id_idx").on(
      t.chatId,
      t.createdAt,
      t.id,
    ),
  })
);

export const insertChatMessageSchema = createInsertSchema(chatMessagesTable).omit({
  id: true,
  createdAt: true,
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

// WhatsApp Status (a.k.a. "stories") — 24h-lived broadcasts. Scoped per
// owner_phone like every other multi-tenant table. We persist both incoming
// statuses from contacts (so the operator can review them in-app) AND
// outbound statuses posted from the app (so we can show them under
// "My Status"). Expired rows are filtered on read.
export const whatsappStatusesTable = pgTable(
  "whatsapp_statuses",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    // For incoming: the contact JID (participant) who posted. For mine: the
    // owner's own JID. Used to group statuses by author in the UI.
    authorJid: text("author_jid").notNull(),
    authorPhone: text("author_phone").notNull(), // digits-only, for joining to chats
    authorName: text("author_name").notNull(),
    // "text" | "image" | "video"
    statusType: text("status_type").notNull(),
    textContent: text("text_content"),
    // Background color for text statuses (hex string like "#0f3a4d"). Mirrors
    // WhatsApp's coloured text-status backgrounds.
    backgroundColor: text("background_color"),
    mediaUrl: text("media_url"),
    mediaMimeType: text("media_mime_type"),
    caption: text("caption"),
    waMessageId: text("wa_message_id"),
    isMine: boolean("is_mine").notNull().default(false),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusesWaMessageIdUnique: uniqueIndex(
      "whatsapp_statuses_wa_message_id_unique"
    ).on(t.channelId, t.waMessageId),
  })
);

export type WhatsappStatusRow = typeof whatsappStatusesTable.$inferSelect;

// Per-owner text shortcuts (a.k.a. "text expander"). Operators type a short
// trigger like "/almt" in the chat composer and it expands to a longer canned
// phrase. Triggers are matched case-insensitively, so we store the shortcut
// as-typed but enforce uniqueness on its lowercased form per owner.
export const textShortcutsTable = pgTable(
  "text_shortcuts",
  {
    id: serial("id").primaryKey(),
    // Shared at superadmin level: every shortcut is keyed by the owning
    // super_admin user.
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    shortcut: text("shortcut").notNull(),
    replacement: text("replacement").notNull(),
    // Optional image URL (sheet sync col C "Link"). When present, sending the
    // shortcut to a chat delivers the image as a photo with `replacement` as
    // the caption; otherwise `replacement` is sent as plain text.
    link: text("link"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    textShortcutsUserLowerUnique: uniqueIndex(
      "text_shortcuts_user_lower_unique"
    ).on(t.userId, sql`lower(${t.shortcut})`),
  })
);

export type TextShortcutRow = typeof textShortcutsTable.$inferSelect;

// All business-data tables below carry `ownerPhone` for per-WhatsApp-account
// isolation. The app is multi-tenant by WhatsApp number: each operator who
// scans a QR gets their own catalog, settings, knowledge base, and AI
// persona — none of it leaks across accounts.
export const knowledgeTypesTable = pgTable(
  "knowledge_types",
  {
    id: serial("id").primaryKey(),
    ownerPhone: text("owner_phone").notNull(),
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    value: text("value").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    knowledgeTypesOwnerValueUnique: uniqueIndex("knowledge_types_owner_value_unique").on(
      t.ownerPhone,
      t.value
    ),
    knowledgeTypesUserValueUnique: uniqueIndex("knowledge_types_user_value_unique").on(
      t.userId,
      t.value
    ),
  })
);

export type KnowledgeType = typeof knowledgeTypesTable.$inferSelect;

export const knowledgeTable = pgTable(
  "knowledge_entries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    knowledgeEntriesUserIdIdx: index("knowledge_entries_user_id_idx").on(t.userId),
  })
);

export const insertKnowledgeSchema = createInsertSchema(knowledgeTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type KnowledgeEntry = typeof knowledgeTable.$inferSelect;
export type InsertKnowledge = z.infer<typeof insertKnowledgeSchema>;

export const settingsTable = pgTable(
  "settings",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),
    systemPrompt: text("system_prompt").notNull(),
    autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(true),
    replyDelayMin: integer("reply_delay_min").notNull().default(1),
    replyDelayMax: integer("reply_delay_max").notNull().default(3),
    fallbackMessage: text("fallback_message").notNull(),
    // How long the chatbot flow's Default trigger stays muted after a flow
    // ends/exits, so the AI can handle follow-ups instead of immediately
    // restarting the menu. Allowed: 5, 15, 30, 60, 120. Keyword triggers are
    // never affected by this.
    flowCooldownMinutes: integer("flow_cooldown_minutes").notNull().default(5),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    settingsChannelUnique: uniqueIndex("settings_channel_unique").on(t.channelId),
  })
);

export type Settings = typeof settingsTable.$inferSelect;

// Business-wide ("general") AI settings. One row per tenant, keyed on the
// tenant root user (channelsTable.userId is always the effective owner, so
// these are resolved via that id). Super admin edits; supervisor/agent read
// only. Per-channel auto-reply stays on settingsTable.autoReplyEnabled; the
// legacy general columns on settingsTable are no longer read once a tenant
// row exists.
export const tenantSettingsTable = pgTable(
  "tenant_settings",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    systemPrompt: text("system_prompt").notNull(),
    replyDelayMin: integer("reply_delay_min").notNull().default(1),
    replyDelayMax: integer("reply_delay_max").notNull().default(3),
    fallbackMessage: text("fallback_message").notNull(),
    flowCooldownMinutes: integer("flow_cooldown_minutes").notNull().default(5),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantSettingsOwnerUnique: uniqueIndex("tenant_settings_owner_unique").on(
      t.ownerUserId
    ),
  })
);

export type TenantSettings = typeof tenantSettingsTable.$inferSelect;

export const productsTable = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    price: integer("price").notNull(),
    priceSilver: integer("price_silver"),
    priceGold: integer("price_gold"),
    pricePlatinum: integer("price_platinum"),
    priceReseller: integer("price_reseller"),
    priceDistributor: integer("price_distributor"),
    // Internal stock figures — surfaced to agents only, never sent to customers.
    stock: integer("stock"),
    stockOnHand: integer("stock_on_hand"),
    imageUrl: text("image_url"),
    flyerUrl: text("flyer_url"),
    productUrl: text("product_url"),
    videoUrls: text("video_urls").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Composite uniqueness: each super_admin has their own SKU namespace.
    productsUserCodeUnique: uniqueIndex("products_user_code_unique").on(
      t.userId,
      t.code
    ),
  })
);

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;

// Point-of-sale sales orders created from the chat Info sidebar's Order tab.
// An order belongs to the app user (super_admin tenant) and optionally to the
// chat it was raised from. Line items snapshot name/code/price at the time of
// sale so later catalog edits don't rewrite historical orders. All money is
// stored as integer Rupiah (no decimals), matching products.price.
//
// PPN (Indonesian VAT, 11%) is per-order:
//   - ppnEnabled=false → ppnAmount=0, total=subtotal
//   - ppnEnabled=true, ppnIncluded=true  (prices already include PPN) →
//       subtotal = sum(line totals); ppnAmount = subtotal - round(subtotal/1.11);
//       total = subtotal
//   - ppnEnabled=true, ppnIncluded=false (prices exclude PPN) →
//       subtotal = sum(line totals); ppnAmount = round(subtotal*11/100);
//       total = subtotal + ppnAmount
// The server is authoritative for these figures (see routes/sales-orders.ts).
export const salesOrdersTable = pgTable(
  "sales_orders",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The chat this order was raised from. Nullable + set null so deleting a
    // chat keeps the historical order. Used by the "send to customer" action.
    chatId: integer("chat_id").references(() => chatsTable.id, {
      onDelete: "set null",
    }),
    // Snapshots of the customer at order time, so the order and its Sheet row
    // stay correct even if the chat is later renamed or removed.
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    ppnEnabled: boolean("ppn_enabled").notNull().default(false),
    ppnIncluded: boolean("ppn_included").notNull().default(true),
    ppnRate: integer("ppn_rate").notNull().default(11),
    subtotal: integer("subtotal").notNull().default(0),
    // Order-level (global) discount applied to the subtotal before PPN.
    // discountType: "percent" → discountValue is 0-100; "amount" → discountValue
    // is integer Rupiah. discountAmount is the server-computed nominal Rupiah
    // actually subtracted (clamped to subtotal), snapshotted for the Sheet row.
    discountType: text("discount_type").notNull().default("amount"),
    discountValue: integer("discount_value").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    ppnAmount: integer("ppn_amount").notNull().default(0),
    total: integer("total").notNull().default(0),
    note: text("note"),
    // "draft" → saved/editable; "sent" → summary delivered to the customer.
    status: text("status").notNull().default("draft"),
    syncedToSheetAt: timestamp("synced_to_sheet_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    salesOrdersUserIdx: index("sales_orders_user_idx").on(t.userId),
    salesOrdersChatIdx: index("sales_orders_chat_idx").on(t.chatId),
  })
);

export const salesOrderItemsTable = pgTable(
  "sales_order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
    // Catalog product this line came from, or null for a free-text custom
    // item. Plain integer (no FK): a product may be deleted after the sale
    // without orphaning historical orders.
    productId: integer("product_id"),
    code: text("code"),
    name: text("name").notNull(),
    qty: integer("qty").notNull().default(1),
    // Unit price (snapshot, editable at order time) and the computed line
    // total (qty * price), both integer Rupiah.
    price: integer("price").notNull().default(0),
    // Per-line discount applied to the line gross (qty * price). discountType:
    // "percent" → discountValue is 0-100; "amount" → discountValue is integer
    // Rupiah. lineTotal is the net (after discount) qty*price, integer Rupiah.
    discountType: text("discount_type").notNull().default("amount"),
    discountValue: integer("discount_value").notNull().default(0),
    lineTotal: integer("line_total").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    salesOrderItemsOrderIdx: index("sales_order_items_order_idx").on(
      t.orderId
    ),
  })
);

export type SalesOrder = typeof salesOrdersTable.$inferSelect;
export type SalesOrderItem = typeof salesOrderItemsTable.$inferSelect;
