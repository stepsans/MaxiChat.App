import { db } from "@workspace/db";
import {
  chatsTable,
  chatMessagesTable,
  channelsTable,
  contactLabelsTable,
  contactLeadStatusTable,
  customerLabelsTable,
} from "@workspace/db";
import { sql, inArray, eq, and } from "drizzle-orm";

// Shared analytics aggregations. Extracted from routes/analytics.ts so the
// per-route handlers AND the aggregated mobile dashboard (GET /dashboard) read
// from a SINGLE source of truth — avoiding the metric divergence warned about
// in the dashboard spec (K1). All functions are channel-scoped: pass the
// already-resolved channel ids; an empty list yields the zero/empty result
// (per-phone isolation — never surface another account's numbers).

export interface AnalyticsSummaryResult {
  totalChats: number;
  aiHandled: number;
  needsHuman: number;
  closed: number;
  leads: number;
  notLeads: number;
  totalMessages: number;
  todayChats: number;
  leadRate: number;
  chatsByLabel: Array<{ id: number; name: string; color: string; count: number }>;
}

export async function computeAnalyticsSummary(
  channelIds: number[]
): Promise<AnalyticsSummaryResult> {
  if (channelIds.length === 0) {
    return {
      totalChats: 0,
      aiHandled: 0,
      needsHuman: 0,
      closed: 0,
      leads: 0,
      notLeads: 0,
      totalMessages: 0,
      todayChats: 0,
      leadRate: 0,
      chatsByLabel: [],
    };
  }

  const chats = await db
    .select()
    .from(chatsTable)
    .where(inArray(chatsTable.channelId, channelIds));

  const totalChats = chats.length;
  const aiHandled = chats.filter((c) => c.status === "ai_handled").length;
  const needsHuman = chats.filter((c) => c.status === "needs_human").length;
  const closed = chats.filter((c) => c.status === "closed").length;

  const chatIds = chats.map((c) => c.id);

  // Lead status is contact-level (contact_lead_status, keyed owner + phone),
  // so a chat "is a lead" when its owner + phone has a matching row — counted
  // per chat (mirroring the old per-chat tally), now resolved across channels.
  const leadCounts = chatIds.length
    ? await db
        .select({
          leadStatus: contactLeadStatusTable.leadStatus,
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(chatsTable)
        .innerJoin(channelsTable, eq(chatsTable.channelId, channelsTable.id))
        .innerJoin(
          contactLeadStatusTable,
          and(
            eq(contactLeadStatusTable.ownerUserId, channelsTable.userId),
            eq(contactLeadStatusTable.phoneNumber, chatsTable.phoneNumber)
          )
        )
        .where(inArray(chatsTable.id, chatIds))
        .groupBy(contactLeadStatusTable.leadStatus)
    : [];
  const leads = leadCounts.find((r) => r.leadStatus === "lead")?.count ?? 0;
  const notLeads = leadCounts.find((r) => r.leadStatus === "not_lead")?.count ?? 0;

  const [msgCount] = chatIds.length
    ? await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(chatMessagesTable)
        .where(inArray(chatMessagesTable.chatId, chatIds))
    : [{ count: 0 }];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayChats = chats.filter((c) => new Date(c.createdAt) >= today).length;

  const leadRate = totalChats > 0 ? Math.round((leads / totalChats) * 100) : 0;

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
        .innerJoin(channelsTable, eq(chatsTable.channelId, channelsTable.id))
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

  return {
    totalChats,
    aiHandled,
    needsHuman,
    closed,
    leads,
    notLeads,
    totalMessages: msgCount?.count ?? 0,
    todayChats,
    leadRate,
    chatsByLabel,
  };
}

export interface CommonQuestionResult {
  question: string;
  count: number;
}

const COMMON_QUESTION_FALLBACK: CommonQuestionResult[] = [
  { question: "Pertanyaan harga", count: 0 },
  { question: "Cara order", count: 0 },
  { question: "Info produk", count: 0 },
];

export async function computeCommonQuestions(
  channelIds: number[]
): Promise<CommonQuestionResult[]> {
  if (channelIds.length === 0) return COMMON_QUESTION_FALLBACK;

  const ownedChats = await db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(inArray(chatsTable.channelId, channelIds));
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

  return result.length === 0 ? COMMON_QUESTION_FALLBACK : result;
}

export interface StorageUsageResult {
  chatCount: number;
  messageCount: number;
  estimatedBytes: number;
}

// channelIds here are the tenant owner's channels (storage is tenant-wide,
// independent of the channel switcher).
export async function computeStorageUsage(
  channelIds: number[]
): Promise<StorageUsageResult> {
  if (channelIds.length === 0) {
    return { chatCount: 0, messageCount: 0, estimatedBytes: 0 };
  }

  // Bare table reference => row type => pg_column_size of the whole tuple.
  // Sum as bigint (node-postgres returns it as a string) so it can't overflow
  // int4 on large tenants.
  const [chatAgg] = await db
    .select({
      count: sql<number>`cast(count(*) as int)`,
      bytes: sql<string>`coalesce(sum(pg_column_size(${chatsTable})), 0)::bigint`,
    })
    .from(chatsTable)
    .where(inArray(chatsTable.channelId, channelIds));

  const [msgAgg] = await db
    .select({
      count: sql<number>`cast(count(*) as int)`,
      bytes: sql<string>`coalesce(sum(pg_column_size(${chatMessagesTable})), 0)::bigint`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(inArray(chatsTable.channelId, channelIds));

  const estimatedBytes = Number(chatAgg?.bytes ?? 0) + Number(msgAgg?.bytes ?? 0);

  return {
    chatCount: chatAgg?.count ?? 0,
    messageCount: msgAgg?.count ?? 0,
    estimatedBytes,
  };
}
