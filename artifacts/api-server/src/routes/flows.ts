import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import { chatbotFlowsTable, chatsTable } from "@workspace/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { MEDIA_DIR } from "./whatsapp";
import { requireSupervisorOrAbove } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import {
  requireConnectedChannel,
  requireOwnedChannelLoose,
  resolveChannelScope,
} from "../lib/channel-context";

// Matrix gates declared once at the top so they layer cleanly with the
// existing requireSupervisorOrAbove guards on each handler below.
const flowView = requirePermission("flows", "view");
const flowCreate = requirePermission("flows", "create");
const flowEdit = requirePermission("flows", "edit");
const flowDelete = requirePermission("flows", "delete");

// Graph schema mirrors lib/db/schema/chatbot.ts but uses zod v3 (the API
// server's installed zod version) so types align with the rest of routes/*.
const FlowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["trigger", "message", "question", "end", "ai", "products"]),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    matchType: z.enum(["default", "keyword"]).optional(),
    keywords: z.array(z.string()).optional(),
    text: z.string().optional(),
    imageUrl: z.string().nullish(),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
    strictOptions: z.boolean().optional(),
    strictRetryMessage: z.string().optional(),
    productIds: z.array(z.number().int().positive()).optional(),
    aiInstruction: z.string().optional(),
  }),
});

const flowImageUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
      } catch {}
      cb(null, MEDIA_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype || "");
      cb(null, `${randomUUID()}${ext ? "." + ext : ""}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
  limits: { fileSize: 16 * 1024 * 1024 },
});
const FlowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
});
const FlowGraphSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
});

const router = Router();

function serializeSummary(f: typeof chatbotFlowsTable.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    isActive: f.isActive,
    channelId: f.channelId,
    updatedAt: f.updatedAt.toISOString(),
  };
}

function serializeFull(f: typeof chatbotFlowsTable.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    isActive: f.isActive,
    channelId: f.channelId,
    graph: f.graph as { nodes: unknown[]; edges: unknown[] },
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

// --- Image upload for Message/Question nodes ---
router.post("/upload-image", requireSupervisorOrAbove, flowCreate, flowImageUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "Missing file" }); return; }
    const url = `/api/media/${path.basename(req.file.path)}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "Failed to upload flow image");
    res.status(500).json({ error: "Internal server error" });
  }
});

// List flows. Supports "All channels" via X-Channel-Id: all → returns flows
// across every channel the operator owns. Single-channel mode returns only
// that channel's flows.
router.get("/", flowView, async (req, res): Promise<void> => {
  const scope = await resolveChannelScope(req, res);
  if (!scope) return;
  if (scope.channelIds.length === 0) { res.json([]); return; }
  const rows = await db
    .select()
    .from(chatbotFlowsTable)
    .where(inArray(chatbotFlowsTable.channelId, scope.channelIds))
    .orderBy(desc(chatbotFlowsTable.isActive), desc(chatbotFlowsTable.updatedAt));
  res.json(rows.map(serializeSummary));
});

router.post("/", requireSupervisorOrAbove, flowCreate, async (req, res): Promise<void> => {
  const channel = await requireConnectedChannel(req, res);
  if (!channel) return;
  const parsed = z
    .object({ name: z.string().trim().min(1).max(120) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }
  const [row] = await db
    .insert(chatbotFlowsTable)
    .values({
      channelId: channel.id,
      name: parsed.data.name,
      graph: { nodes: [], edges: [] },
    })
    .returning();
  res.status(201).json(serializeFull(row!));
});

// All by-id endpoints scope to the active channel — picking "all" in the
// header on a single-flow detail/edit page is nonsensical, so we reject it.
router.get("/:id", flowView, async (req, res): Promise<void> => {
  const channel = await requireOwnedChannelLoose(req, res);
  if (!channel) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const [row] = await db
    .select()
    .from(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.channelId, channel.id)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(row));
});

router.patch("/:id", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const channel = await requireOwnedChannelLoose(req, res);
  if (!channel) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      graph: FlowGraphSchema.optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) patch["name"] = parsed.data.name;
  if (parsed.data.graph !== undefined) {
    // Defensive: ensure all edges reference existing nodes, and that any
    // sourceHandle (used for question-option branches) refers to a real
    // option id on the source question node. Without this a malformed PATCH
    // could leave the runtime unable to advance past a question.
    const nodesById = new Map(parsed.data.graph.nodes.map((n) => [n.id, n]));
    for (const e of parsed.data.graph.edges) {
      const src = nodesById.get(e.source);
      const tgt = nodesById.get(e.target);
      if (!src || !tgt) {
        res
          .status(400)
          .json({ error: "invalid_graph", message: "edge references missing node" });
        return;
      }
      if (e.sourceHandle) {
        const opts = src.data.options ?? [];
        if (!opts.some((o) => o.id === e.sourceHandle)) {
          res.status(400).json({
            error: "invalid_graph",
            message: "edge sourceHandle does not match any option on source node",
          });
          return;
        }
      }
    }
    patch["graph"] = parsed.data.graph;
  }

  const [row] = await db
    .update(chatbotFlowsTable)
    .set(patch)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.channelId, channel.id)))
    .returning();
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(row));
});

router.delete("/:id", requireSupervisorOrAbove, flowDelete, async (req, res): Promise<void> => {
  const channel = await requireOwnedChannelLoose(req, res);
  if (!channel) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const result = await db
    .delete(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.channelId, channel.id)))
    .returning({ id: chatbotFlowsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "not_found" }); return; }
  res.status(204).end();
});

router.post("/:id/activate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const channel = await requireConnectedChannel(req, res);
  if (!channel) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }

  // Swap atomically: deactivate any current active flow for this channel,
  // then activate the requested one. The partial unique index on
  // (channel_id) WHERE is_active rejects two active rows per channel.
  const updated = await db.transaction(async (tx) => {
    await tx
      .update(chatbotFlowsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(chatbotFlowsTable.channelId, channel.id), eq(chatbotFlowsTable.isActive, true))
      );
    const [row] = await tx
      .update(chatbotFlowsTable)
      .set({ isActive: true, updatedAt: new Date() })
      .where(
        and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.channelId, channel.id))
      )
      .returning();
    return row;
  });
  if (!updated) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(updated));
});

// Clear flow cooldown / in-progress state for all chats of the active
// channel. Useful for testing: lets the Default trigger fire on the next
// message without waiting the configured cooldown window.
router.post("/reset-cooldown", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const channel = await requireConnectedChannel(req, res);
  if (!channel) return;
  const result = await db
    .update(chatsTable)
    .set({ flowState: null })
    .where(eq(chatsTable.channelId, channel.id));
  res.json({ cleared: result.rowCount ?? 0 });
});

router.post("/active/deactivate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const channel = await requireOwnedChannelLoose(req, res);
  if (!channel) return;
  await db
    .update(chatbotFlowsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(eq(chatbotFlowsTable.channelId, channel.id), eq(chatbotFlowsTable.isActive, true))
    );
  res.status(204).end();
});

export default router;
