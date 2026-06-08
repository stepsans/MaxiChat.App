import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { usersTable } from "./auth";

// One subscription row per tenant OWNER (super_admin, parent_user_id NULL).
// Invited members never get a row — they inherit the owner's subscription.
// Created lazily (getOrCreateSubscription) for pre-existing owners so there is
// no migration backfill. Status drives the eventual access-enforcement layer
// (not implemented yet): expired/suspended tenants can still log in but lose
// send/AI/add-user/add-channel rights.
export const subscriptionStatuses = [
  "trial",
  "active",
  "past_due",
  "expired",
  "suspended",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    // End of the current paid/trial period. After this instant the tenant is
    // considered overdue (the enforcement layer will flip status to expired).
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // Dunning (Billing v2 — FASE F). When an unpaid monthly_close invoice goes
    // overdue the sweep records when dunning began and, once past the grace
    // window, a grace deadline after which writes are blocked (past_due → the
    // tenant keeps full access until grace_until, then read-only). Null when no
    // dunning is in progress.
    dunningStartedAt: timestamp("dunning_started_at", { withTimezone: true }),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("subscriptions_user_unique").on(t.userId)]
);

export const subscriptionStatusSchema = z.enum(subscriptionStatuses);

export type SubscriptionRow = typeof subscriptionsTable.$inferSelect;
