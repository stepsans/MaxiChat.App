import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { usersTable } from "./auth";

// Visual chatbot flow graph. Flows are OWNER-scoped (a super-admin's account)
// and assigned to one or more channels via the chatbot_flow_channels join
// table (empty assignment = global, i.e. every channel the owner has). At most
// one ACTIVE flow may apply to any given channel — this is enforced by the
// overlap-aware transactional swap in the activate endpoint (a global active
// flow overlaps every channel and so excludes all others).
export const chatbotFlowsTable = pgTable("chatbot_flows", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
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
});

export type ChatbotFlowRow = typeof chatbotFlowsTable.$inferSelect;

// ----- Graph shape (validated at the API boundary) -----

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  // "ai": handoff node — sends optional intro text, then AI takes over the
  //       conversation (Default trigger muted by the per-owner cooldown).
  type: z.enum(["trigger", "message", "question", "end", "ai", "products"]),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    // trigger
    matchType: z.enum(["default", "keyword"]).optional(),
    keywords: z.array(z.string()).optional(),
    // message / question / ai
    text: z.string().optional(),
    // message / question — optional image to send along with text. Stored as
    // a URL (either external http(s) or internal /api/media/<file>).
    imageUrl: z.string().nullish(),
    // question
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
    // question — when true, off-option replies re-ask the question instead
    // of muting the flow and handing off to AI.
    strictOptions: z.boolean().optional(),
    // question — when strictOptions=true, this message is sent right before
    // the question is re-asked, to nudge the customer to pick a valid option.
    strictRetryMessage: z.string().optional(),
    // question — when true, the question text is rephrased by AI (same meaning,
    // varied natural wording) each time it's sent so it doesn't feel like a
    // canned bot message. Answer options are never rephrased.
    aiRephrase: z.boolean().optional(),
    // products — list of product ids to send (image + Nama/Kode/Harga caption).
    productIds: z.array(z.number().int().positive()).optional(),
    // ai — extra instruction appended to the global system prompt while this
    // node's handoff is active (per-node AI persona). Empty = global prompt only.
    aiInstruction: z.string().optional(),
    // ai — restrict the AI's knowledge-base reference to these specific entry
    // ids while this node's handoff is active. Empty = full knowledge base.
    knowledgeIds: z.array(z.number().int().positive()).optional(),
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
