import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  chatsTable,
  channelsTable,
  chatMessagesTable,
  productsTable,
  salesInsightsTable,
  salesAuditEventsTable,
  type SalesInsightRow,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { resolveOwnerUserId } from "./seed";
import { buildProductCatalogText } from "./product-catalog";
import {
  buildAnalysisSystemPrompt,
  buildTranscript,
  deriveWaitingStatus,
  parseInsight,
  type SalesInsightAnalysis,
  type WaitingStatus,
} from "./sales-insight-build";
import { logger } from "./logger";

// ===========================================================================
// AI Sales Assistant — conversation analysis service. Reads a chat's recent
// history + the tenant's product catalog, asks the AI to score the lead, and
// persists the result as the per-chat "AI Sales Insight". Token usage is
// attributed to the tenant owner; every analysis writes a sales audit event.
// Fails EXPLICITLY (throws) rather than fabricating an analysis.
// ===========================================================================

// How many recent messages feed the model. Enough context for intent without
// blowing token spend on very long threads.
const HISTORY_LIMIT = 30;

export interface ChatAnalysisResult {
  ownerUserId: number;
  channelId: number;
  chatId: number;
  contactPhone: string;
  contactName: string | null;
  leadScore: number;
  waitingStatus: WaitingStatus | null;
  analysis: SalesInsightAnalysis;
  lastMessageId: number | null;
  insight: SalesInsightRow;
}

// Analyse one chat and upsert its AI Sales Insight. Returns the structured
// result so the detection engine can decide whether to auto-create an
// opportunity. Throws on any hard failure (chat/channel missing, model returned
// no recoverable JSON) so callers never persist a fabricated score.
export async function analyzeAndPersistChat(
  chatId: number
): Promise<ChatAnalysisResult> {
  const [chat] = await db
    .select()
    .from(chatsTable)
    .where(eq(chatsTable.id, chatId))
    .limit(1);
  if (!chat) throw new Error(`Chat ${chatId} tidak ditemukan.`);

  const [channel] = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, chat.channelId))
    .limit(1);
  if (!channel) throw new Error(`Channel ${chat.channelId} tidak ditemukan.`);

  const ownerUserId = await resolveOwnerUserId(channel.userId);

  // Recent messages, newest-first then reversed to chronological order — same
  // ordering discipline as generateAiReply so the model sees the latest turns.
  const recent = (
    await db
      .select({
        id: chatMessagesTable.id,
        direction: chatMessagesTable.direction,
        content: chatMessagesTable.content,
        senderName: chatMessagesTable.senderName,
      })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chatId))
      .orderBy(desc(chatMessagesTable.id))
      .limit(HISTORY_LIMIT)
  ).reverse();

  if (recent.length === 0) {
    throw new Error(`Chat ${chatId} belum memiliki pesan untuk dianalisa.`);
  }

  const lastMsg = recent[recent.length - 1]!;
  const lastDirection =
    lastMsg.direction === "outbound"
      ? ("outbound" as const)
      : ("inbound" as const);
  const waitingStatus = deriveWaitingStatus(lastDirection);

  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.userId, ownerUserId))
    .orderBy(asc(productsTable.id));
  const catalogText = buildProductCatalogText(products);

  const systemPrompt = buildAnalysisSystemPrompt(catalogText);
  const transcript = buildTranscript(
    recent.map((m) => ({ direction: m.direction, content: m.content }))
  );

  const { client, model, provider } = await resolveAiClient(ownerUserId);
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Analisa percakapan berikut dan balas HANYA dengan satu objek JSON sesuai format.\n\n--- PERCAKAPAN ---\n${transcript}\n--- END PERCAKAPAN ---`,
      },
    ],
    max_tokens: 800,
    temperature: 0,
  });

  // Owner-attributed, best-effort — never blocks the analysis.
  void recordAiUsage({
    ownerUserId,
    channelId: chat.channelId,
    provider,
    model,
    usage: response.usage,
  });

  const content = response.choices[0]?.message?.content ?? "";
  const analysis = parseInsight(content);
  // Fail explicitly: the model returned nothing we can trust. We must NOT write
  // a fabricated zero-score insight that looks like a real analysis.
  if (!analysis) {
    throw new Error(
      "AI tidak mengembalikan analisa JSON yang valid untuk chat ini."
    );
  }

  // Upsert the per-chat insight (one row per chat).
  const [insight] = await db
    .insert(salesInsightsTable)
    .values({
      ownerUserId,
      chatId,
      channelId: chat.channelId,
      contactPhone: chat.phoneNumber,
      leadScore: analysis.leadScore,
      intentCategory: analysis.intentCategory,
      estimatedValueIdr: analysis.estimatedValueIdr,
      productInterest: analysis.productInterest,
      scoreReason: analysis.scoreReason,
      aiNotes: analysis.aiNotes,
      recommendation: analysis.recommendation,
      waitingStatus,
      lastMessageId: lastMsg.id,
      analyzedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: salesInsightsTable.chatId,
      set: {
        leadScore: analysis.leadScore,
        intentCategory: analysis.intentCategory,
        estimatedValueIdr: analysis.estimatedValueIdr,
        productInterest: analysis.productInterest,
        scoreReason: analysis.scoreReason,
        aiNotes: analysis.aiNotes,
        recommendation: analysis.recommendation,
        waitingStatus,
        lastMessageId: lastMsg.id,
        analyzedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  // Audit: every analysis records a lead-score event; a non-empty
  // recommendation records a separate recommendation event. Both are
  // AI/system-generated (actorUserId null). Best-effort — an audit write must
  // never fail the analysis.
  try {
    await db.insert(salesAuditEventsTable).values({
      ownerUserId,
      actorUserId: null,
      eventType: "lead_scored",
      detail: {
        chatId,
        leadScore: analysis.leadScore,
        intentCategory: analysis.intentCategory,
        waitingStatus,
        source: "ai",
      },
    });
    if (analysis.recommendation) {
      await db.insert(salesAuditEventsTable).values({
        ownerUserId,
        actorUserId: null,
        eventType: "recommendation",
        detail: {
          chatId,
          recommendation: analysis.recommendation,
          source: "ai",
        },
      });
    }
  } catch (err) {
    logger.warn({ err, chatId }, "sales-insight: audit write failed");
  }

  return {
    ownerUserId,
    channelId: chat.channelId,
    chatId,
    contactPhone: chat.phoneNumber,
    contactName: chat.contactName,
    leadScore: analysis.leadScore,
    waitingStatus,
    analysis,
    lastMessageId: lastMsg.id,
    insight: insight!,
  };
}
