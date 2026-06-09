import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Per-tenant-owner onboarding checklist tracking.
// One row per owner (uniqueIndex on owner_user_id). The MaxiChat CS team can
// view every tenant's progress from the admin panel.
export const onboardingChecklistTable = pgTable(
  "onboarding_checklists",
  {
    id: serial("id").primaryKey(),
    // FK to the owner user (parent_user_id IS NULL, team_role = 'super_admin').
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    // ── Checklist items: each is a boolean + a completion timestamp. ──
    // 1. Connect a WhatsApp channel.
    waConnected: boolean("wa_connected").notNull().default(false),
    waConnectedAt: timestamp("wa_connected_at", { withTimezone: true }),
    // 2. Add at least one product to the catalog.
    productAdded: boolean("product_added").notNull().default(false),
    productAddedAt: timestamp("product_added_at", { withTimezone: true }),
    // 3. Add at least one team member (agent/supervisor).
    teamMemberAdded: boolean("team_member_added").notNull().default(false),
    teamMemberAddedAt: timestamp("team_member_added_at", {
      withTimezone: true,
    }),
    // 4. Receive or send at least one message.
    // (boolean derivable: firstMessageAt IS NOT NULL)
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    // 5. Try the AI feature (AI generated a reply at least once).
    aiTriedAt: timestamp("ai_tried_at", { withTimezone: true }),
    // 6. Create or activate one chatbot flow.
    flowActivated: boolean("flow_activated").notNull().default(false),
    flowActivatedAt: timestamp("flow_activated_at", { withTimezone: true }),

    // ── Health score (0–100, recomputed each checklist update). ──
    // wa_connected=30, product_added=20, first_message=20,
    // team_member_added=15, ai_tried=10, flow_activated=5.
    healthScore: integer("health_score").notNull().default(0),
    // Risk level from health score: 'low' >= 70, 'medium' 40-69, 'high' < 40.
    riskLevel: text("risk_level").notNull().default("high"),

    // When the MaxiChat CS team last followed up with this tenant.
    lastCsFollowUpAt: timestamp("last_cs_follow_up_at", { withTimezone: true }),
    lastCsNote: text("last_cs_note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("onboarding_owner_unique").on(t.ownerUserId)]
);

export type OnboardingChecklistRow =
  typeof onboardingChecklistTable.$inferSelect;
