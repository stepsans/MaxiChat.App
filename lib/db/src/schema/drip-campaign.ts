import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Queue for behavior-based drip emails/WA messages during a trial.
// Triggers are CONDITION-based (not day-based), processed by a background job.
// triggerType: 'wa_not_connected_24h' | 'product_empty' | 'no_message_3d' |
//              'trial_expiring_2d' | 'trial_expired' | 'high_engagement'
export const dripCampaignQueueTable = pgTable(
  "drip_campaign_queue",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // The trigger that produced this drip.
    triggerType: text("trigger_type").notNull(),
    // Delivery channel: 'email' | 'whatsapp' (sent via the owner's WA number).
    channel: text("channel").notNull().default("email"),
    // Queue status: 'pending' | 'sent' | 'failed' | 'skipped'.
    status: text("status").notNull().default("pending"),
    // Send schedule (may be in the future for delayed sends).
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    // When it was actually sent.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Error message if it failed.
    errorMessage: text("error_message"),
    // Extra metadata (email subject, target WA number, etc).
    metadata: jsonb("metadata"),
    // Dedupe: one triggerType per owner per trial period.
    // Format: '{ownerUserId}:{triggerType}:{trialStartDate}'.
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("drip_owner_status_idx").on(t.ownerUserId, t.status),
    index("drip_scheduled_idx").on(t.scheduledAt, t.status),
    index("drip_dedupe_idx").on(t.dedupeKey),
  ]
);

export type DripCampaignQueueRow = typeof dripCampaignQueueTable.$inferSelect;
