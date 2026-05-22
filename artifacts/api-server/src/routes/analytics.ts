import { Router } from "express";
import { db } from "@workspace/db";
import { chatsTable, chatMessagesTable } from "@workspace/db";
import { eq, sql, inArray } from "drizzle-orm";
import { getCurrentOwnerPhone } from "./whatsapp";

const router = Router();

router.get("/summary", async (req, res) => {
  try {
    // Per-phone isolation: when disconnected, every counter is zero — the
    // dashboard for "nobody logged in" must not show another account's
    // numbers. Once a phone connects, only its own data is aggregated.
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res.json({
        totalChats: 0,
        aiHandled: 0,
        needsHuman: 0,
        closed: 0,
        hotLeads: 0,
        closingLeads: 0,
        coldLeads: 0,
        totalMessages: 0,
        todayChats: 0,
        closingRate: 0,
      });
    }
    const chats = await db
      .select()
      .from(chatsTable)
      .where(eq(chatsTable.ownerPhone, ownerPhone));

    const totalChats = chats.length;
    const aiHandled = chats.filter((c) => c.status === "ai_handled").length;
    const needsHuman = chats.filter((c) => c.status === "needs_human").length;
    const closed = chats.filter((c) => c.status === "closed").length;
    const hotLeads = chats.filter((c) => c.tag === "hot_lead").length;
    const closingLeads = chats.filter((c) => c.tag === "closing").length;
    const coldLeads = chats.filter((c) => c.tag === "cold").length;

    const chatIds = chats.map((c) => c.id);
    const [msgCount] = chatIds.length
      ? await db
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(chatMessagesTable)
          .where(inArray(chatMessagesTable.chatId, chatIds))
      : [{ count: 0 }];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayChats = chats.filter(
      (c) => new Date(c.createdAt) >= today
    ).length;

    const closingRate = totalChats > 0 ? Math.round((closingLeads / totalChats) * 100) : 0;

    res.json({
      totalChats,
      aiHandled,
      needsHuman,
      closed,
      hotLeads,
      closingLeads,
      coldLeads,
      totalMessages: msgCount?.count ?? 0,
      todayChats,
      closingRate,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get analytics summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/common-questions", async (req, res) => {
  try {
    // Scope keyword counting to the current account's inbound messages only.
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res.json([
        { question: "Pertanyaan harga", count: 0 },
        { question: "Cara order", count: 0 },
        { question: "Info produk", count: 0 },
      ]);
    }
    const ownedChats = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(eq(chatsTable.ownerPhone, ownerPhone));
    const ownedChatIds = ownedChats.map((c) => c.id);
    const inboundMessages = ownedChatIds.length
      ? await db
          .select({ content: chatMessagesTable.content })
          .from(chatMessagesTable)
          .where(
            sql`${chatMessagesTable.direction} = 'inbound'
                AND ${chatMessagesTable.chatId} IN (${sql.join(
              ownedChatIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
      : [];

    const keywords: Record<string, string[]> = {
      "Pertanyaan harga": ["harga", "berapa", "price", "cost", "murah", "mahal"],
      "Cara order": ["order", "pesan", "beli", "cara", "purchase", "bayar"],
      "Info produk": ["produk", "product", "info", "detail", "fitur", "spec"],
      "Komplain / masalah": ["komplain", "masalah", "error", "problem", "rusak", "tidak bisa"],
      "Testimoni / review": ["review", "testimoni", "bukti", "nyata", "puas"],
      "Pengiriman": ["kirim", "delivery", "ongkir", "shipping", "ekspedisi"],
      "Garansi": ["garansi", "warranty", "jaminan", "retur", "refund"],
      "Stok tersedia": ["stok", "stock", "ready", "ada", "tersedia"],
    };

    const counts: Record<string, number> = {};
    for (const msg of inboundMessages) {
      const lower = msg.content.toLowerCase();
      for (const [topic, kws] of Object.entries(keywords)) {
        if (kws.some((kw) => lower.includes(kw))) {
          counts[topic] = (counts[topic] ?? 0) + 1;
        }
      }
    }

    const result = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([question, count]) => ({ question, count }));

    if (result.length === 0) {
      res.json([
        { question: "Pertanyaan harga", count: 0 },
        { question: "Cara order", count: 0 },
        { question: "Info produk", count: 0 },
      ]);
    } else {
      res.json(result);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to get common questions");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
