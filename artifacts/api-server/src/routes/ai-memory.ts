import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  tenantAiChatMessagesTable,
  tenantAiMemoriesTable,
} from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { resolveAiClient } from "../lib/ai-provider";
import { recordAiUsage } from "../lib/ai-usage";
import { SendAiMemoryChatBody } from "@workspace/api-zod";

const router = Router();

async function resolveOwner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

const HISTORY_LIMIT = 30; // messages returned to the UI / fed to the model
const MEMORY_LIMIT = 50; // active memories injected as context

// GET /ai-memory/chat — conversation history (oldest → newest).
router.get("/chat", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const rows = await db
    .select({
      id: tenantAiChatMessagesTable.id,
      role: tenantAiChatMessagesTable.role,
      content: tenantAiChatMessagesTable.content,
      createdAt: tenantAiChatMessagesTable.createdAt,
    })
    .from(tenantAiChatMessagesTable)
    .where(eq(tenantAiChatMessagesTable.ownerUserId, ownerUserId))
    .orderBy(desc(tenantAiChatMessagesTable.createdAt))
    .limit(HISTORY_LIMIT);

  res.json({
    messages: rows
      .reverse()
      .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
});

// POST /ai-memory/chat — teach the AI. Stores the message, asks the model for a
// reply + an optional durable memory, persists both, returns the reply.
router.post("/chat", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const parsed = SendAiMemoryChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const message = parsed.data.message.trim();
  if (!message) {
    res.status(400).json({ error: "Empty message" });
    return;
  }

  // Persist the tenant's message first so history stays consistent.
  await db.insert(tenantAiChatMessagesTable).values({
    ownerUserId,
    role: "user",
    content: message,
  });

  // Context: existing memories + recent turns.
  const [memories, history] = await Promise.all([
    db
      .select({ content: tenantAiMemoriesTable.content })
      .from(tenantAiMemoriesTable)
      .where(
        and(
          eq(tenantAiMemoriesTable.ownerUserId, ownerUserId),
          eq(tenantAiMemoriesTable.archived, false)
        )
      )
      .orderBy(desc(tenantAiMemoriesTable.createdAt))
      .limit(MEMORY_LIMIT),
    db
      .select({
        role: tenantAiChatMessagesTable.role,
        content: tenantAiChatMessagesTable.content,
      })
      .from(tenantAiChatMessagesTable)
      .where(eq(tenantAiChatMessagesTable.ownerUserId, ownerUserId))
      .orderBy(desc(tenantAiChatMessagesTable.createdAt))
      .limit(16),
  ]);

  const memoryList = memories.length
    ? memories.map((m) => `- ${m.content}`).join("\n")
    : "(belum ada)";

  const systemPrompt = `Kamu adalah asisten pembelajaran untuk MaxiChat. Tenant (pemilik bisnis) sedang mengajarimu cara menangani percakapan & menilai lead untuk bisnis MEREKA. Tugasmu:
1. Balas singkat, ramah, dalam Bahasa Indonesia — konfirmasi apa yang kamu pahami/ingat.
2. Bila pesan tenant berisi instruksi, preferensi, atau fakta yang perlu DIINGAT untuk ke depan, ekstrak menjadi SATU kalimat memori yang jelas & mandiri. Bila tidak ada yang perlu diingat (mis. cuma sapaan/pertanyaan), set memory = null.

Hal yang sudah kamu ingat tentang tenant ini:
${memoryList}

Balas HANYA JSON valid tanpa markdown: {"reply": "<balasan ke tenant>", "memory": "<satu kalimat untuk diingat, atau null>"}`;

  const { client, model, provider } = await resolveAiClient(ownerUserId);

  type Completion = {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const chatMessages = [
    { role: "system", content: systemPrompt },
    // oldest → newest (history is fetched newest-first)
    ...history.reverse().map((m) => ({ role: m.role, content: m.content })),
  ];

  let reply = "Baik, sudah saya catat.";
  let memory: string | null = null;
  try {
    const completion = (await (client.chat.completions.create as Function)({
      model,
      messages: chatMessages,
      max_tokens: 500,
      temperature: 0.3,
    })) as Completion;

    const raw = completion.choices?.[0]?.message?.content ?? "";
    try {
      const json = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim()) as {
        reply?: string;
        memory?: string | null;
      };
      if (typeof json.reply === "string" && json.reply.trim()) reply = json.reply.trim();
      if (typeof json.memory === "string" && json.memory.trim()) memory = json.memory.trim();
    } catch {
      // Model didn't return JSON — use the raw text as the reply, save nothing.
      if (raw.trim()) reply = raw.trim();
    }

    try {
      await recordAiUsage({
        ownerUserId,
        channelId: null,
        provider,
        model,
        usage: completion.usage ?? null,
      });
    } catch { /* non-fatal */ }
  } catch (err) {
    console.error("[ai-memory] chat completion failed:", err);
  }

  // Persist the assistant reply, and the memory if one was extracted.
  await db.insert(tenantAiChatMessagesTable).values({
    ownerUserId,
    role: "assistant",
    content: reply,
  });
  if (memory) {
    await db.insert(tenantAiMemoriesTable).values({ ownerUserId, content: memory });
  }

  res.json({ reply, memory });
});

// GET /ai-memory — active saved memories (newest first).
router.get("/", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const rows = await db
    .select({
      id: tenantAiMemoriesTable.id,
      content: tenantAiMemoriesTable.content,
      createdAt: tenantAiMemoriesTable.createdAt,
    })
    .from(tenantAiMemoriesTable)
    .where(
      and(
        eq(tenantAiMemoriesTable.ownerUserId, ownerUserId),
        eq(tenantAiMemoriesTable.archived, false)
      )
    )
    .orderBy(desc(tenantAiMemoriesTable.createdAt))
    .limit(200);

  res.json({ items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
});

// DELETE /ai-memory/:id — forget a memory (soft archive, scoped to owner).
router.delete("/:id", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db
    .update(tenantAiMemoriesTable)
    .set({ archived: true })
    .where(
      and(
        eq(tenantAiMemoriesTable.id, id),
        eq(tenantAiMemoriesTable.ownerUserId, ownerUserId),
        eq(tenantAiMemoriesTable.archived, false)
      )
    )
    .returning({ id: tenantAiMemoriesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }

  res.json({ ok: true });
});

export default router;
