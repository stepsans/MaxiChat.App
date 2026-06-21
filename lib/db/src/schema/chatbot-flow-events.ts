import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { chatbotFlowsTable } from "./chatbot";

// One row per chatbot-menu option a customer presses, recorded ONLY when the
// question node has `data.countInDashboard === true` (spec A.4 / 3.1). Powers the
// "Menu chatbot ditekan" dashboard panel. Labels are snapshotted at write time so
// later flow edits don't rewrite history. Best-effort write — never blocks the
// flow runtime.
export const chatbotFlowEventsTable = pgTable(
  "chatbot_flow_events",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    flowId: integer("flow_id")
      .notNull()
      .references(() => chatbotFlowsTable.id, { onDelete: "cascade" }),
    // Question node id in the flow graph.
    nodeId: text("node_id").notNull(),
    // Selected option id (from the chosen edge's sourceHandle). Null if unknown.
    optionId: text("option_id"),
    // Snapshot of the chosen option's label, e.g. "Sales".
    nodeLabel: text("node_label").notNull(),
    // 1 = main menu, 2 = submenu, … (depth of the question in the flow).
    level: integer("level").notNull().default(1),
    // Parent question node id, to stitch a multi-step path together.
    parentNodeId: text("parent_node_id"),
    // Chat/contact that pressed the option (chats.id). Plain int — best-effort.
    contactId: integer("contact_id"),
    channelId: integer("channel_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("chatbot_flow_events_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("chatbot_flow_events_owner_node_idx").on(t.ownerUserId, t.flowId, t.nodeId),
  ]
);

export type ChatbotFlowEventRow = typeof chatbotFlowEventsTable.$inferSelect;
