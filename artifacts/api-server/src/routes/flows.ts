import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import { chatbotFlowsTable, chatsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { MEDIA_DIR, getCurrentOwnerPhone } from "./whatsapp";
import { requireSupervisorOrAbove } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";

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
    updatedAt: f.updatedAt.toISOString(),
  };
}

function serializeFull(f: typeof chatbotFlowsTable.$inferSelect) {
  return {
    id: f.id,
    name: f.name,
    isActive: f.isActive,
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

router.get("/", flowView, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.json([]); return; }
  const rows = await db
    .select()
    .from(chatbotFlowsTable)
    .where(eq(chatbotFlowsTable.ownerPhone, ownerPhone))
    .orderBy(desc(chatbotFlowsTable.isActive), desc(chatbotFlowsTable.updatedAt));
  res.json(rows.map(serializeSummary));
  return;
});

router.post("/", requireSupervisorOrAbove, flowCreate, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(400).json({ error: "no_owner_phone" }); return; }
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
      ownerPhone,
      name: parsed.data.name,
      graph: { nodes: [], edges: [] },
    })
    .returning();
  res.status(201).json(serializeFull(row!));
  return;
});

router.get("/:id", flowView, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(404).json({ error: "not_found" }); return; }
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const [row] = await db
    .select()
    .from(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.ownerPhone, ownerPhone)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(row));
  return;
});

router.patch("/:id", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(404).json({ error: "not_found" }); return; }
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
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.ownerPhone, ownerPhone)))
    .returning();
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(row));
  return;
});

router.delete("/:id", requireSupervisorOrAbove, flowDelete, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(404).json({ error: "not_found" }); return; }
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const result = await db
    .delete(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.ownerPhone, ownerPhone)))
    .returning({ id: chatbotFlowsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "not_found" }); return; }
  res.status(204).end();
  return;
});

router.post("/:id/activate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(404).json({ error: "not_found" }); return; }
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }

  // Swap atomically: deactivate any current active flow for this owner, then
  // activate the requested one. The partial unique index on (owner_phone)
  // WHERE is_active otherwise rejects two active rows.
  const updated = await db.transaction(async (tx) => {
    await tx
      .update(chatbotFlowsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(chatbotFlowsTable.ownerPhone, ownerPhone), eq(chatbotFlowsTable.isActive, true))
      );
    const [row] = await tx
      .update(chatbotFlowsTable)
      .set({ isActive: true, updatedAt: new Date() })
      .where(
        and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.ownerPhone, ownerPhone))
      )
      .returning();
    return row;
  });
  if (!updated) { res.status(404).json({ error: "not_found" }); return; }
  res.json(serializeFull(updated));
  return;
});

// Clear flow cooldown / in-progress state for all chats of the current owner.
// Useful for testing: lets the Default trigger fire on the next message
// without waiting the configured cooldown window.
router.post("/reset-cooldown", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.json({ cleared: 0 }); return; }
  const result = await db
    .update(chatsTable)
    .set({ flowState: null })
    .where(eq(chatsTable.ownerPhone, ownerPhone));
  res.json({ cleared: result.rowCount ?? 0 });
  return;
});

router.post("/active/deactivate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) { res.status(204).end(); return; }
  await db
    .update(chatbotFlowsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(eq(chatbotFlowsTable.ownerPhone, ownerPhone), eq(chatbotFlowsTable.isActive, true))
    );
  res.status(204).end();
  return;
});

export default router;
