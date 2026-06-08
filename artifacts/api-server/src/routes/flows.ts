import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { chatbotFlowsTable, chatbotFlowChannelsTable, chatsTable } from "@workspace/db";
import { and, eq, ne, desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveOwnerUserId } from "../lib/seed";
import { saveTenantMedia } from "../lib/tenant-storage";
import { requireSupervisorOrAbove } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import { requireOwnerUserId, requireConnectedChannel } from "../lib/channel-context";
import {
  replaceChannelAssignments,
  loadChannelIdsBatch,
  parseChannelIdsInput,
  verifyChannelOwnership,
} from "../lib/channel-assignments";

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
    aiRephrase: z.boolean().optional(),
    productIds: z.array(z.number().int().positive()).optional(),
    aiInstruction: z.string().optional(),
    knowledgeIds: z.array(z.number().int().positive()).optional(),
  }),
});

const flowImageUpload = multer({
  storage: multer.memoryStorage(),
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

// Defensive graph integrity check shared by PATCH and import: ensure every
// edge references existing nodes, and that any sourceHandle (question-option
// branch) refers to a real option id on its source node. Returns an error
// message string when invalid, or null when the graph is sound. Without this a
// malformed graph could leave the runtime unable to advance past a question.
function validateGraphIntegrity(
  graph: z.infer<typeof FlowGraphSchema>,
): string | null {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    const src = nodesById.get(e.source);
    const tgt = nodesById.get(e.target);
    if (!src || !tgt) return "edge references missing node";
    if (e.sourceHandle) {
      const opts = src.data.options ?? [];
      if (!opts.some((o) => o.id === e.sourceHandle)) {
        return "edge sourceHandle does not match any option on source node";
      }
    }
  }
  return null;
}

const router = Router();

// `channelIds` is the resource→channel assignment surfaced on the wire.
// Empty array = global (the flow runs on every channel the owner has). One+
// = scoped to those channels only. Mirrors products / knowledge / shortcuts.
function serializeSummary(
  f: typeof chatbotFlowsTable.$inferSelect,
  channelIds: number[],
) {
  return {
    id: f.id,
    name: f.name,
    isActive: f.isActive,
    channelIds,
    updatedAt: f.updatedAt.toISOString(),
  };
}

function serializeFull(
  f: typeof chatbotFlowsTable.$inferSelect,
  channelIds: number[],
) {
  return {
    id: f.id,
    name: f.name,
    isActive: f.isActive,
    channelIds,
    graph: f.graph as { nodes: unknown[]; edges: unknown[] },
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

type FlowTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Enforce "at most one active flow per channel" for a freshly-activated or
// channel-reassigned target. Deactivates every OTHER active owner flow whose
// effective channel set OVERLAPS the target's. A flow with no channel
// assignments is GLOBAL (covers every channel), so it overlaps any other flow.
// Disjoint active flows are left untouched. Self-guards: if the target isn't
// active, it does nothing. Must run inside a transaction that already holds the
// owner advisory lock so concurrent activations can't race past each other.
async function deactivateOverlappingFlows(
  tx: FlowTx,
  ownerUserId: number,
  targetId: number,
): Promise<void> {
  const [target] = await tx
    .select({ isActive: chatbotFlowsTable.isActive })
    .from(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, targetId), eq(chatbotFlowsTable.userId, ownerUserId)))
    .limit(1);
  if (!target || !target.isActive) return;

  const targetRows = await tx
    .select({ cid: chatbotFlowChannelsTable.channelId })
    .from(chatbotFlowChannelsTable)
    .where(eq(chatbotFlowChannelsTable.flowId, targetId));
  const targetSet = new Set(targetRows.map((r) => r.cid));
  const targetGlobal = targetSet.size === 0;

  const others = await tx
    .select({ id: chatbotFlowsTable.id })
    .from(chatbotFlowsTable)
    .where(
      and(
        eq(chatbotFlowsTable.userId, ownerUserId),
        eq(chatbotFlowsTable.isActive, true),
        ne(chatbotFlowsTable.id, targetId),
      ),
    );
  if (others.length === 0) return;

  const otherIds = others.map((o) => o.id);
  const assignRows = await tx
    .select({
      fid: chatbotFlowChannelsTable.flowId,
      cid: chatbotFlowChannelsTable.channelId,
    })
    .from(chatbotFlowChannelsTable)
    .where(inArray(chatbotFlowChannelsTable.flowId, otherIds));
  const byFlow = new Map<number, Set<number>>();
  for (const oid of otherIds) byFlow.set(oid, new Set());
  for (const r of assignRows) byFlow.get(r.fid)?.add(r.cid);

  const toDeactivate = otherIds.filter((oid) => {
    const set = byFlow.get(oid)!;
    const otherGlobal = set.size === 0;
    if (targetGlobal || otherGlobal) return true; // global overlaps all
    for (const c of set) if (targetSet.has(c)) return true;
    return false;
  });
  if (toDeactivate.length > 0) {
    await tx
      .update(chatbotFlowsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(chatbotFlowsTable.id, toDeactivate));
  }
}

// --- Image upload for Message/Question nodes ---
router.post("/upload-image", requireSupervisorOrAbove, flowCreate, flowImageUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "Missing file" }); return; }
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const { url } = await saveTenantMedia({
      ownerUserId,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || "image/jpeg",
      kind: "flow",
      preferredFilename: req.file.originalname,
    });
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "Failed to upload flow image");
    res.status(500).json({ error: "Internal server error" });
  }
});

// List all flows for the owner. Flows are owner-scoped (not bound to the
// active channel header); each carries its channel assignment so the UI can
// show where it runs.
router.get("/", flowView, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const rows = await db
    .select()
    .from(chatbotFlowsTable)
    .where(eq(chatbotFlowsTable.userId, ownerUserId))
    .orderBy(desc(chatbotFlowsTable.isActive), desc(chatbotFlowsTable.updatedAt));
  const map = await loadChannelIdsBatch("flow", rows.map((r) => r.id));
  res.json(rows.map((r) => serializeSummary(r, map.get(r.id) ?? [])));
});

router.post("/", requireSupervisorOrAbove, flowCreate, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const parsed = z
    .object({ name: z.string().trim().min(1).max(120) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }
  const channelIds = parseChannelIdsInput(req.body?.channelIds);
  if (channelIds === "invalid") {
    res.status(400).json({ error: "Invalid channelIds" });
    return;
  }
  if ((await verifyChannelOwnership(ownerUserId, channelIds)) === "forbidden") {
    res.status(400).json({ error: "Invalid channelIds" });
    return;
  }
  const [row] = await db
    .insert(chatbotFlowsTable)
    .values({
      userId: ownerUserId,
      name: parsed.data.name,
      graph: { nodes: [], edges: [] },
    })
    .returning();
  await replaceChannelAssignments("flow", row!.id, channelIds, ownerUserId);
  const map = await loadChannelIdsBatch("flow", [row!.id]);
  res.status(201).json(serializeFull(row!, map.get(row!.id) ?? []));
});

// Import a flow from a backup export. Creates a brand-new flow (inactive, no
// channel assignments) from a name + full graph so a restore can never collide
// with the "one active flow per channel" invariant or overwrite an existing
// flow. The graph is validated structurally (same as PATCH); product/knowledge
// ids inside the graph are kept verbatim — they resolve when restored to the
// same account and dangle harmlessly otherwise.
router.post("/import", requireSupervisorOrAbove, flowCreate, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120),
      graph: FlowGraphSchema,
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    return;
  }
  const graphError = validateGraphIntegrity(parsed.data.graph);
  if (graphError) {
    res.status(400).json({ error: "invalid_graph", message: graphError });
    return;
  }
  const [row] = await db
    .insert(chatbotFlowsTable)
    .values({
      userId: ownerUserId,
      name: parsed.data.name,
      graph: parsed.data.graph,
    })
    .returning();
  res.status(201).json(serializeFull(row!, []));
});

router.get("/:id", flowView, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const [row] = await db
    .select()
    .from(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.userId, ownerUserId)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  const map = await loadChannelIdsBatch("flow", [row.id]);
  res.json(serializeFull(row, map.get(row.id) ?? []));
});

router.patch("/:id", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
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

  const channelIds = parseChannelIdsInput(req.body?.channelIds);
  if (channelIds === "invalid") {
    res.status(400).json({ error: "Invalid channelIds" });
    return;
  }
  // Pre-flight channel ownership check before any write.
  if ((await verifyChannelOwnership(ownerUserId, channelIds)) === "forbidden") {
    res.status(400).json({ error: "Invalid channelIds" });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) patch["name"] = parsed.data.name;
  if (parsed.data.graph !== undefined) {
    const graphError = validateGraphIntegrity(parsed.data.graph);
    if (graphError) {
      res.status(400).json({ error: "invalid_graph", message: graphError });
      return;
    }
    patch["graph"] = parsed.data.graph;
  }

  const [row] = await db
    .update(chatbotFlowsTable)
    .set(patch)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.userId, ownerUserId)))
    .returning();
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  await replaceChannelAssignments("flow", row.id, channelIds, ownerUserId);
  // A channel reassignment can make an already-active flow overlap another
  // active flow (e.g. adding a channel that another active flow covers). Re-run
  // the per-channel invariant so the just-edited flow wins on its new channels.
  if (channelIds !== undefined) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ownerUserId})`);
      await deactivateOverlappingFlows(tx, ownerUserId, row.id);
    });
  }
  const map = await loadChannelIdsBatch("flow", [row.id]);
  res.json(serializeFull(row, map.get(row.id) ?? []));
});

router.delete("/:id", requireSupervisorOrAbove, flowDelete, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const result = await db
    .delete(chatbotFlowsTable)
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.userId, ownerUserId)))
    .returning({ id: chatbotFlowsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "not_found" }); return; }
  res.status(204).end();
});

router.post("/:id/activate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }

  // Activating a flow must keep the "at most one active flow per channel"
  // invariant. We take an owner-scoped advisory lock so concurrent
  // activate/reassign requests for the same owner serialize, then mark the
  // target active and deactivate any other active flow whose channel set
  // overlaps it (see deactivateOverlappingFlows). Disjoint sets stay active.
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ownerUserId})`);
    const [row] = await tx
      .update(chatbotFlowsTable)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.userId, ownerUserId)))
      .returning();
    if (!row) return null;
    await deactivateOverlappingFlows(tx, ownerUserId, row.id);
    return row;
  });
  if (!updated) { res.status(404).json({ error: "not_found" }); return; }
  const map = await loadChannelIdsBatch("flow", [updated.id]);
  res.json(serializeFull(updated, map.get(updated.id) ?? []));
});

router.post("/:id/deactivate", requireSupervisorOrAbove, flowEdit, async (req, res): Promise<void> => {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(404).json({ error: "not_found" }); return; }
  const result = await db
    .update(chatbotFlowsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(chatbotFlowsTable.id, id), eq(chatbotFlowsTable.userId, ownerUserId)))
    .returning({ id: chatbotFlowsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "not_found" }); return; }
  res.status(204).end();
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

export default router;
