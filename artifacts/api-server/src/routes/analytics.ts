import { Router } from "express";
import { db } from "@workspace/db";
import {
  chatsTable,
  chatMessagesTable,
  channelsTable,
  contactLabelsTable,
  customerLabelsTable,
} from "@workspace/db";
import { sql, inArray, eq, and } from "drizzle-orm";
import { resolveChannelScope } from "../lib/channel-context";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// Every analytics endpoint is read-only aggregation, so all of them are
// gated by analytics.canView.
router.use(requirePermission("analytics", "view"));

router.get("/summary", async (req, res): Promise<void> => {
  try {
    // Per-phone isolation: when disconnected, every counter is zero — the
    // dashboard for "nobody logged in" must not show another account's
    // numbers. Once a phone connects, only its own data is aggregated.
    const scope = await resolveChannelScope(req, res);
    if (!scope) return;
    if (scope.channelIds.length === 0) {
      res.json({
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
        chatsByLabel: [],
      });
      return;
    }
    const chats = await db
      .select()
      .from(chatsTable)
      .where(inArray(chatsTable.channelId, scope.channelIds));

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

    // Count chats carrying each customer label, scoped to this account's chats.
    // Labels are contact-level (owner + phone), so a chat "carries" a label when
    // contact_labels has a row for its owner + phone number — this naturally
    // includes labels set from another channel for the same contact.
    const chatsByLabel = chatIds.length
      ? await db
          .select({
            id: customerLabelsTable.id,
            name: customerLabelsTable.name,
            color: customerLabelsTable.color,
            count: sql<number>`cast(count(*) as int)`,
          })
          .from(chatsTable)
          .innerJoin(
            channelsTable,
            eq(chatsTable.channelId, channelsTable.id)
          )
          .innerJoin(
            contactLabelsTable,
            and(
              eq(contactLabelsTable.ownerUserId, channelsTable.userId),
              eq(contactLabelsTable.phoneNumber, chatsTable.phoneNumber)
            )
          )
          .innerJoin(
            customerLabelsTable,
            eq(contactLabelsTable.labelId, customerLabelsTable.id)
          )
          .where(inArray(chatsTable.id, chatIds))
          .groupBy(
            customerLabelsTable.id,
            customerLabelsTable.name,
            customerLabelsTable.color
          )
          .orderBy(sql`count(*) desc`, customerLabelsTable.name)
      : [];

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
      chatsByLabel,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get analytics summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/common-questions", async (req, res): Promise<void> => {
  try {
    // Scope keyword counting to the current account's inbound messages only.
    const scope = await resolveChannelScope(req, res);
    if (!scope) return;
    if (scope.channelIds.length === 0) {
      res.json([
        { question: "Pertanyaan harga", count: 0 },
        { question: "Cara order", count: 0 },
        { question: "Info produk", count: 0 },
      ]);
      return;
    }
    const ownedChats = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(inArray(chatsTable.channelId, scope.channelIds));
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
