import { Router } from "express";
import { db } from "@workspace/db";
import { chatsTable, chatMessagesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  ListChatsQueryParams,
  UpdateChatBody,
  SendManualReplyBody,
  TakeoverChatBody,
  GetChatParams,
  UpdateChatParams,
  SendManualReplyParams,
  TakeoverChatParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const parsed = ListChatsQueryParams.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;
    const tag = parsed.success ? parsed.data.tag : undefined;

    let query = db.select().from(chatsTable).orderBy(desc(chatsTable.lastMessageAt));
    const results = await query;

    let filtered = results;
    if (status && status !== "all") {
      filtered = filtered.filter((c) => c.status === status);
    }
    if (tag && tag !== "all") {
      filtered = filtered.filter((c) => c.tag === tag);
    }

    res.json(
      filtered.map((c) => ({
        ...c,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list chats");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, parsed.data.id));
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const messages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chat.id))
      .orderBy(chatMessagesTable.createdAt);

    res.json({
      ...chat,
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
      createdAt: chat.createdAt.toISOString(),
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const idParsed = UpdateChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateChatBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db
      .update(chatsTable)
      .set(bodyParsed.data)
      .where(eq(chatsTable.id, idParsed.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Chat not found" });

    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/reply", async (req, res) => {
  try {
    const idParsed = SendManualReplyParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = SendManualReplyBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, idParsed.data.id));
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const [message] = await db
      .insert(chatMessagesTable)
      .values({
        chatId: idParsed.data.id,
        direction: "outbound",
        content: bodyParsed.data.content,
        isAiGenerated: false,
      })
      .returning();

    await db
      .update(chatsTable)
      .set({ lastMessage: bodyParsed.data.content, lastMessageAt: new Date() })
      .where(eq(chatsTable.id, idParsed.data.id));

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send reply");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/takeover", async (req, res) => {
  try {
    const idParsed = TakeoverChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = TakeoverChatBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db
      .update(chatsTable)
      .set({
        isHumanTakeover: bodyParsed.data.takeover,
        status: bodyParsed.data.takeover ? "needs_human" : "ai_handled",
      })
      .where(eq(chatsTable.id, idParsed.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Chat not found" });

    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle takeover");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
