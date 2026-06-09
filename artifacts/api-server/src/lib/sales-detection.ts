import { asc, eq } from "drizzle-orm";
import {
  db,
  chatsTable,
  channelsTable,
  pipelineStagesTable,
  opportunitiesTable,
  opportunityProductsTable,
  salesAssistantSettingsTable,
  salesAuditEventsTable,
} from "@workspace/db";
import {
  ownerHasSalesAssistant,
  getPipelineByType,
} from "./sales-assistant";
import { analyzeAndPersistChat } from "./sales-insight";
import { resolveOwnerUserId } from "./seed";
import { logger } from "./logger";
import type { OpportunityCandidate } from "./sales-insight-build";

// ===========================================================================
// AI Sales Assistant — in-process detection queue.
// ===========================================================================

const DEBOUNCE_MS = 8_000;
const pendingTimers = new Map<number, NodeJS.Timeout>();
const inFlight = new Set<number>();

const DEFAULT_AUTO_CREATE_ENABLED = false;
const DEFAULT_AUTO_CREATE_THRESHOLD = 70;

interface AutoCreateSettings {
  autoCreateEnabled: boolean;
  autoCreateThreshold: number;
}

async function getAutoCreateSettings(
  ownerUserId: number
): Promise<AutoCreateSettings> {
  const [row] = await db
    .select()
    .from(salesAssistantSettingsTable)
    .where(eq(salesAssistantSettingsTable.ownerUserId, ownerUserId))
    .limit(1);
  return {
    autoCreateEnabled: row?.autoCreateEnabled ?? DEFAULT_AUTO_CREATE_ENABLED,
    autoCreateThreshold:
      row?.autoCreateThreshold ?? DEFAULT_AUTO_CREATE_THRESHOLD,
  };
}

export function enqueueChatDetection(chatId: number): void {
  if (!Number.isInteger(chatId) || chatId <= 0) return;
  const existing = pendingTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(chatId);
    void runDetection(chatId);
  }, DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
  pendingTimers.set(chatId, timer);
}

async function resolveChatOwner(chatId: number): Promise<number | null> {
  const [row] = await db
    .select({ channelUserId: channelsTable.userId })
    .from(chatsTable)
    .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
    .where(eq(chatsTable.id, chatId))
    .limit(1);
  if (!row) return null;
  return resolveOwnerUserId(row.channelUserId);
}

async function runDetection(chatId: number): Promise<void> {
  if (inFlight.has(chatId)) {
    enqueueChatDetection(chatId);
    return;
  }
  inFlight.add(chatId);
  try {
    const ownerUserId = await resolveChatOwner(chatId);
    if (ownerUserId == null) return;
    const entitled = await ownerHasSalesAssistant(ownerUserId);
    if (!entitled) return;

    const result = await analyzeAndPersistChat(chatId);
    await applyAutoCreateForResult(result);
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, chatId },
      "sales-detection: analysis failed"
    );
  } finally {
    inFlight.delete(chatId);
  }
}

type AnalysisResult = Awaited<ReturnType<typeof analyzeAndPersistChat>>;

// Upsert one opportunity candidate into the DB. Uses (chatId, intentKey) as
// the dedup key: same topic → update score/notes, new topic → insert.
async function upsertOpportunity(
  result: AnalysisResult,
  candidate: OpportunityCandidate
): Promise<number | null> {
  // Route to the matching pipeline by type, falling back to default.
  const pipeline = await getPipelineByType(
    result.ownerUserId,
    candidate.pipelineType
  );
  if (!pipeline) return null;

  // First stage of this specific pipeline (where new opportunities land).
  const [firstStage] = await db
    .select({ id: pipelineStagesTable.id })
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.pipelineId, pipeline.id))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);

  const now = new Date();

  // Try insert; on conflict (same chatId + intentKey) update the AI fields.
  const [opp] = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId: result.ownerUserId,
      chatId: result.chatId,
      channelId: result.channelId,
      pipelineId: pipeline.id,
      contactPhone: result.contactPhone,
      contactName: result.contactName,
      stageId: firstStage?.id ?? null,
      intentKey: candidate.intentKey,
      intentType: candidate.intentType,
      leadScore: candidate.leadScore,
      intentCategory: candidate.intentCategory,
      estimatedValueIdr: candidate.estimatedValueIdr,
      status: "open",
      waitingStatus: result.waitingStatus,
      productInterest: candidate.products,
      scoreReason: candidate.scoreReason,
      aiNotes: candidate.aiNotes,
      recommendation: candidate.recommendation,
      analyzedAt: now,
      analyzedMessageIds: result.analyzedMessageIds,
      keyQuotes: candidate.keyQuotes,
      lastActivityAt: now,
    })
    .onConflictDoUpdate({
      target: [opportunitiesTable.chatId, opportunitiesTable.intentKey],
      // Only update AI-generated fields; preserve stage/status/assignment.
      set: {
        leadScore: candidate.leadScore,
        intentCategory: candidate.intentCategory,
        estimatedValueIdr: candidate.estimatedValueIdr,
        waitingStatus: result.waitingStatus,
        productInterest: candidate.products,
        scoreReason: candidate.scoreReason,
        aiNotes: candidate.aiNotes,
        recommendation: candidate.recommendation,
        analyzedAt: now,
        analyzedMessageIds: result.analyzedMessageIds,
        keyQuotes: candidate.keyQuotes,
        lastActivityAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: opportunitiesTable.id });

  if (!opp) return null;

  // Sync opportunity_products: replace with the current candidate's list.
  if (candidate.products.length > 0) {
    await db
      .delete(opportunityProductsTable)
      .where(eq(opportunityProductsTable.opportunityId, opp.id));
    await db.insert(opportunityProductsTable).values(
      candidate.products.map((name) => ({
        opportunityId: opp.id,
        productName: name,
      }))
    );
  }

  return opp.id;
}

export async function applyAutoCreateForResult(
  result: AnalysisResult
): Promise<void> {
  const settings = await getAutoCreateSettings(result.ownerUserId);
  if (!settings.autoCreateEnabled) return;

  for (const candidate of result.analysis.opportunities) {
    if (candidate.leadScore < settings.autoCreateThreshold) continue;

    try {
      const oppId = await upsertOpportunity(result, candidate);
      if (oppId == null) continue;

      await db.insert(salesAuditEventsTable).values({
        ownerUserId: result.ownerUserId,
        opportunityId: oppId,
        actorUserId: null,
        eventType: "opportunity_upserted",
        detail: {
          chatId: result.chatId,
          intentKey: candidate.intentKey,
          intentType: candidate.intentType,
          leadScore: candidate.leadScore,
          estimatedValueIdr: candidate.estimatedValueIdr,
          source: "ai_auto",
        },
      }).onConflictDoNothing();
    } catch (err) {
      logger.warn(
        { err, chatId: result.chatId, intentKey: candidate.intentKey },
        "sales-detection: upsert opportunity failed"
      );
    }
  }
}

export { getAutoCreateSettings };
