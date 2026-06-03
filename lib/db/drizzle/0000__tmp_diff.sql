CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"direction" text NOT NULL,
	"content" text NOT NULL,
	"is_ai_generated" boolean DEFAULT false NOT NULL,
	"media_type" text,
	"media_url" text,
	"media_mime_type" text,
	"media_filename" text,
	"wa_message_id" text,
	"sender_jid" text,
	"sender_phone_digits" text,
	"sender_name" text,
	"mentioned_phone_digits" text[],
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_forwarded" boolean DEFAULT false NOT NULL,
	"forwarding_score" integer DEFAULT 0 NOT NULL,
	"quoted_message_id" integer,
	"quoted_wa_message_id" text,
	"quoted_content" text,
	"quoted_sender" text,
	"reactions" jsonb,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"phone_number" text NOT NULL,
	"contact_name" text NOT NULL,
	"nickname" text,
	"company" text,
	"customer_code" text,
	"status" text DEFAULT 'ai_handled' NOT NULL,
	"tag" text DEFAULT 'none' NOT NULL,
	"is_human_takeover" boolean DEFAULT false NOT NULL,
	"last_message" text,
	"last_message_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"is_lid" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"profile_pic_url" text,
	"profile_pic_checked_at" timestamp with time zone,
	"assigned_user_id" integer,
	"first_assigned_at" timestamp with time zone,
	"first_agent_reply_at" timestamp with time zone,
	"flow_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_labels" (
	"owner_user_id" integer NOT NULL,
	"phone_number" text NOT NULL,
	"label_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_phone" text NOT NULL,
	"user_id" integer,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"price" integer NOT NULL,
	"price_silver" integer,
	"price_gold" integer,
	"price_platinum" integer,
	"price_reseller" integer,
	"price_distributor" integer,
	"stock" integer,
	"stock_on_hand" integer,
	"image_url" text,
	"flyer_url" text,
	"product_url" text,
	"video_urls" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"code" text,
	"name" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"discount_type" text DEFAULT 'amount' NOT NULL,
	"discount_value" integer DEFAULT 0 NOT NULL,
	"line_total" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"chat_id" integer,
	"customer_name" text,
	"customer_phone" text,
	"ppn_enabled" boolean DEFAULT false NOT NULL,
	"ppn_included" boolean DEFAULT true NOT NULL,
	"ppn_rate" integer DEFAULT 11 NOT NULL,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"discount_type" text DEFAULT 'amount' NOT NULL,
	"discount_value" integer DEFAULT 0 NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"ppn_amount" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"synced_to_sheet_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"system_prompt" text NOT NULL,
	"auto_reply_enabled" boolean DEFAULT true NOT NULL,
	"reply_delay_min" integer DEFAULT 1 NOT NULL,
	"reply_delay_max" integer DEFAULT 3 NOT NULL,
	"fallback_message" text NOT NULL,
	"flow_cooldown_minutes" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"system_prompt" text NOT NULL,
	"reply_delay_min" integer DEFAULT 1 NOT NULL,
	"reply_delay_max" integer DEFAULT 3 NOT NULL,
	"fallback_message" text NOT NULL,
	"flow_cooldown_minutes" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_shortcuts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"shortcut" text NOT NULL,
	"replacement" text NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"author_jid" text NOT NULL,
	"author_phone" text NOT NULL,
	"author_name" text NOT NULL,
	"status_type" text NOT NULL,
	"text_content" text,
	"background_color" text,
	"media_url" text,
	"media_mime_type" text,
	"caption" text,
	"wa_message_id" text,
	"is_mine" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_whatsapp" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"owner_phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_whatsapp_owner_phone_unique" UNIQUE("owner_phone")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text,
	"mobile_phone" text,
	"profile_photo_url" text,
	"parent_user_id" integer,
	"team_role" text DEFAULT 'super_admin' NOT NULL,
	"plan" text DEFAULT 'basic' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"assignment_mode" text DEFAULT 'manual' NOT NULL,
	"round_robin_cursor" integer DEFAULT 0 NOT NULL,
	"company_name" text,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#25D366' NOT NULL,
	"icon" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"owner_phone" text,
	"owner_name" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entry_channels" (
	"knowledge_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entry_channels_knowledge_id_channel_id_pk" PRIMARY KEY("knowledge_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "product_channels" (
	"product_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_channels_product_id_channel_id_pk" PRIMARY KEY("product_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "text_shortcut_channels" (
	"shortcut_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "text_shortcut_channels_shortcut_id_channel_id_pk" PRIMARY KEY("shortcut_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "chatbot_flows" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"graph" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"account_email" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sync_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_phone" text NOT NULL,
	"credential_id" integer NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"auto_sync_enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sync_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_phone" text NOT NULL,
	"credential_id" integer NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"auto_sync_enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_sync_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_phone" text NOT NULL,
	"credential_id" integer NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text DEFAULT 'sales order' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortcut_sync_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"owner_phone" text NOT NULL,
	"credential_id" integer NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet_name" text NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"auto_sync_enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"phone_digits" text NOT NULL,
	"match_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_review_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"group_jid" text NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"sheet_credential_id" integer NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text,
	"sheet_tab" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text,
	"drive_credential_id" integer,
	"drive_folder_id" text,
	"drive_folder_name" text,
	"scanner_ai" boolean DEFAULT false NOT NULL,
	"schedule_time" text DEFAULT '18:00' NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_date" text,
	"last_run_status" text DEFAULT 'idle' NOT NULL,
	"last_run_error" text,
	"last_run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"mode" text DEFAULT 'replit' NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"model" text,
	"api_key_enc" text,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"channel_id" integer,
	"provider" text DEFAULT 'replit' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"role" text NOT NULL,
	"menu" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"menu" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_channel_access" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_labels" ADD CONSTRAINT "contact_labels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_labels" ADD CONSTRAINT "contact_labels_label_id_customer_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."customer_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_labels" ADD CONSTRAINT "customer_labels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_types" ADD CONSTRAINT "knowledge_types_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_shortcuts" ADD CONSTRAINT "text_shortcuts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_statuses" ADD CONSTRAINT "whatsapp_statuses_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_whatsapp" ADD CONSTRAINT "user_whatsapp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entry_channels" ADD CONSTRAINT "knowledge_entry_channels_knowledge_id_knowledge_entries_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entry_channels" ADD CONSTRAINT "knowledge_entry_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channels" ADD CONSTRAINT "product_channels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channels" ADD CONSTRAINT "product_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_shortcut_channels" ADD CONSTRAINT "text_shortcut_channels_shortcut_id_text_shortcuts_id_fk" FOREIGN KEY ("shortcut_id") REFERENCES "public"."text_shortcuts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_shortcut_channels" ADD CONSTRAINT "text_shortcut_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatbot_flows" ADD CONSTRAINT "chatbot_flows_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_config" ADD CONSTRAINT "knowledge_sync_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_config" ADD CONSTRAINT "knowledge_sync_config_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sync_config" ADD CONSTRAINT "product_sync_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sync_config" ADD CONSTRAINT "product_sync_config_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_sync_config" ADD CONSTRAINT "sales_order_sync_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_sync_config" ADD CONSTRAINT "sales_order_sync_config_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortcut_sync_config" ADD CONSTRAINT "shortcut_sync_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortcut_sync_config" ADD CONSTRAINT "shortcut_sync_config_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_contacts" ADD CONSTRAINT "google_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_config" ADD CONSTRAINT "ai_review_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_config" ADD CONSTRAINT "ai_review_config_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_config" ADD CONSTRAINT "ai_review_config_sheet_credential_id_credentials_id_fk" FOREIGN KEY ("sheet_credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_config" ADD CONSTRAINT "ai_review_config_drive_credential_id_credentials_id_fk" FOREIGN KEY ("drive_credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_config" ADD CONSTRAINT "ai_provider_config_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_access" ADD CONSTRAINT "user_channel_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_access" ADD CONSTRAINT "user_channel_access_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_chat_wa_message_id_unique" ON "chat_messages" USING btree ("chat_id","wa_message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_chat_id_created_at_id_idx" ON "chat_messages" USING btree ("chat_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_channel_phone_number_unique" ON "chats" USING btree ("channel_id","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_labels_owner_phone_label_unique" ON "contact_labels" USING btree ("owner_user_id","phone_number","label_id");--> statement-breakpoint
CREATE INDEX "contact_labels_label_idx" ON "contact_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "contact_labels_owner_phone_idx" ON "contact_labels" USING btree ("owner_user_id","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_labels_owner_name_unique" ON "customer_labels" USING btree ("owner_user_id","name");--> statement-breakpoint
CREATE INDEX "knowledge_entries_user_id_idx" ON "knowledge_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_types_owner_value_unique" ON "knowledge_types" USING btree ("owner_phone","value");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_types_user_value_unique" ON "knowledge_types" USING btree ("user_id","value");--> statement-breakpoint
CREATE UNIQUE INDEX "products_user_code_unique" ON "products" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "sales_order_items_order_idx" ON "sales_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sales_orders_user_idx" ON "sales_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sales_orders_chat_idx" ON "sales_orders" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_channel_unique" ON "settings" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_settings_owner_unique" ON "tenant_settings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "text_shortcuts_user_lower_unique" ON "text_shortcuts" USING btree ("user_id",lower("shortcut"));--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_statuses_wa_message_id_unique" ON "whatsapp_statuses" USING btree ("channel_id","wa_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_user_label_unique" ON "channels" USING btree ("user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_owner_phone_unique" ON "channels" USING btree ("owner_phone");--> statement-breakpoint
CREATE UNIQUE INDEX "chatbot_flows_channel_active_unique" ON "chatbot_flows" USING btree ("channel_id") WHERE "chatbot_flows"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_user_name_unique" ON "credentials" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sync_owner_phone_unique" ON "knowledge_sync_config" USING btree ("owner_phone");--> statement-breakpoint
CREATE UNIQUE INDEX "product_sync_owner_phone_unique" ON "product_sync_config" USING btree ("owner_phone");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_sync_owner_phone_unique" ON "sales_order_sync_config" USING btree ("owner_phone");--> statement-breakpoint
CREATE UNIQUE INDEX "shortcut_sync_owner_phone_unique" ON "shortcut_sync_config" USING btree ("owner_phone");--> statement-breakpoint
CREATE UNIQUE INDEX "google_contacts_user_phone_unique" ON "google_contacts" USING btree ("user_id","phone_digits");--> statement-breakpoint
CREATE INDEX "google_contacts_user_match_key_idx" ON "google_contacts" USING btree ("user_id","match_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_review_channel_group_unique" ON "ai_review_config" USING btree ("channel_id","group_jid");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_owner_unique" ON "ai_provider_config" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_created_idx" ON "ai_usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_owner_role_menu_key" ON "role_permissions" USING btree ("owner_user_id","role","menu");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permissions_user_menu_key" ON "user_permissions" USING btree ("user_id","menu");--> statement-breakpoint
CREATE UNIQUE INDEX "user_channel_access_user_channel_key" ON "user_channel_access" USING btree ("user_id","channel_id");