import {
  pgTable,
  serial,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

// Visual chatbot flow graph. Each owner_phone may have multiple flows but at
// most one row with is_active=true. Enforced by a partial unique index plus
// transactional swap in the activate endpoint.
export const chatbotFlowsTable = pgTable(
  "chatbot_flows",
  {
    id: serial("id").primaryKey(),
    ownerPhone: text("owner_phone").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    // { nodes: FlowNode[], edges: FlowEdge[] } — see flowGraphSchema below.
    graph: jsonb("graph").notNull().default({ nodes: [], edges: [] }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    chatbotFlowsActiveUnique: uniqueIndex("chatbot_flows_active_unique")
      .on(t.ownerPhone)
      .where(sql`${t.isActive}`),
  })
);

export type ChatbotFlowRow = typeof chatbotFlowsTable.$inferSelect;

// ----- Graph shape (validated at the API boundary) -----

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["trigger", "message", "question", "end"]),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    // trigger
    matchType: z.enum(["default", "keyword"]).optional(),
    keywords: z.array(z.string()).optional(),
    // message / question
    text: z.string().optional(),
    // question
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
  }),
});

export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  // For question nodes: which option this edge belongs to (matches option.id).
  sourceHandle: z.string().nullish(),
});

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});

export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowGraph = z.infer<typeof flowGraphSchema>;
