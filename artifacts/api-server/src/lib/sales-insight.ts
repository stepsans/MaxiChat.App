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
  // IDs of all messages that were in the analysis window.
  analyzedMessageIds: number[];
  lastMessageId: number | null;
  insight: SalesInsightRow;
}

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
  const analyzedMessageIds = recent.map((m) => m.id);

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
    max_tokens: 1200,
    temperature: 0,
  });

  void recordAiUsage({
    ownerUserId,
    channelId: chat.channelId,
    provider,
    model,
    usage: response.usage,
  });

  const content = response.choices[0]?.message?.content ?? "";
  const analysis = parseInsight(content);
  if (!analysis) {
    throw new Error(
      "AI tidak mengembalikan analisa JSON yang valid untuk chat ini."
    );
  }

  // Strip keyQuotes before storing — they live on the opportunity row instead.
  const candidatesForStorage = analysis.opportunities.map((c) => ({
    intentKey: c.intentKey,
    intentType: c.intentType,
    pipelineType: c.pipelineType,
    products: c.products,
    intentCategory: c.intentCategory,
    leadScore: c.leadScore,
    estimatedValueIdr: c.estimatedValueIdr,
    scoreReason: c.scoreReason,
    aiNotes: c.aiNotes,
    recommendation: c.recommendation,
    lastOpenPoint: c.lastOpenPoint,
    stalledReason: c.stalledReason,
  }));

  // Upsert the per-chat insight (aggregate / sidebar view).
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
      detectedCandidates: candidatesForStorage,
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
        detectedCandidates: candidatesForStorage,
        lastMessageId: lastMsg.id,
        analyzedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  try {
    await db.insert(salesAuditEventsTable).values({
      ownerUserId,
      actorUserId: null,
      eventType: "lead_scored",
      detail: {
        chatId,
        leadScore: analysis.leadScore,
        intentCategory: analysis.intentCategory,
        opportunityCount: analysis.opportunities.length,
        waitingStatus,
        source: "ai",
      },
    });
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
    analyzedMessageIds,
    lastMessageId: lastMsg.id,
    insight: insight!,
  };
}
