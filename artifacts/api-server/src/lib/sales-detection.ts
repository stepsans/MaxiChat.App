import { asc, eq } from "drizzle-orm";
import {
  db,
  chatsTable,
  channelsTable,
  pipelineStagesTable,
  opportunitiesTable,
  salesInsightsTable,
  salesAssistantSettingsTable,
  salesAuditEventsTable,
} from "@workspace/db";
import { ownerHasSalesAssistant } from "./sales-assistant";
import { analyzeAndPersistChat } from "./sales-insight";
import { resolveOwnerUserId } from "./seed";
import { logger } from "./logger";

// ===========================================================================
// AI Sales Assistant — in-process detection queue. Inbound message handlers
// call enqueueChatDetection(chatId) (non-blocking, fire-and-forget) and return
// immediately so the socket / webhook path is never blocked by AI work. Per
// chat we DEBOUNCE (a burst of messages collapses into one analysis after a
// quiet window) and we hold a per-chat in-flight lock so the same chat is never
// analysed concurrently. Mirrors the ai-review scheduler's in-flight-Set
// discipline.
// ===========================================================================

// Quiet window after the last inbound message before analysis fires. A
// customer typing several lines in a row collapses into a single run.
const DEBOUNCE_MS = 8_000;

// Per-chat pending debounce timers and the set of chats currently being
// analysed. A trigger arriving while a chat is in-flight re-arms the timer so
// the new message is picked up by a follow-up run.
const pendingTimers = new Map<number, NodeJS.Timeout>();
const inFlight = new Set<number>();

// Default settings when a tenant has never configured the assistant: auto-create
// is OFF (the AI only recommends) at a 70 threshold.
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

// Fire-and-forget entry point from the inbound message pipeline. Schedules a
// debounced analysis for `chatId`. Never throws — a detection failure must
// never break message ingestion.
export function enqueueChatDetection(chatId: number): void {
  if (!Number.isInteger(chatId) || chatId <= 0) return;
  const existing = pendingTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(chatId);
    void runDetection(chatId);
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive solely for a pending analysis.
  if (typeof timer.unref === "function") timer.unref();
  pendingTimers.set(chatId, timer);
}

// Cheap chat → channel → tenant-owner resolution used to entitlement-gate a
// detection run before any AI work. Returns null when the chat/channel is gone.
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
    // Re-arm so the message that arrived during the in-flight run is analysed.
    enqueueChatDetection(chatId);
    return;
  }
  inFlight.add(chatId);
  try {
    // Entitlement gate FIRST: the AI Sales Assistant is Enterprise-only. Resolve
    // the chat's owner cheaply (chat → channel → owner) and bail BEFORE any AI
    // call so a non-Enterprise tenant never spends tokens or has an insight
    // persisted. Auto-detection is an entitled-only behaviour.
    const ownerUserId = await resolveChatOwner(chatId);
    if (ownerUserId == null) return;
    const entitled = await ownerHasSalesAssistant(ownerUserId);
    if (!entitled) return;

    const result = await analyzeAndPersistChat(chatId);

    const settings = await getAutoCreateSettings(result.ownerUserId);
    if (
      settings.autoCreateEnabled &&
      result.leadScore >= settings.autoCreateThreshold
    ) {
      await maybeAutoCreateOpportunity(result);
    }
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

// Idempotently create ONE opportunity for this chat, pre-filled from the AI
// analysis. The unique chat_id index + onConflictDoNothing guarantees a single
// opportunity per chat even under concurrent triggers. All fields stay editable
// later via the opportunity routes.
async function maybeAutoCreateOpportunity(
  result: AnalysisResult
): Promise<void> {
  // Default the deal into the owner's first stage ("New Lead") if any exist.
  const [firstStage] = await db
    .select({ id: pipelineStagesTable.id })
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.ownerUserId, result.ownerUserId))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);

  const inserted = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId: result.ownerUserId,
      chatId: result.chatId,
      channelId: result.channelId,
      contactPhone: result.contactPhone,
      contactName: result.contactName,
      stageId: firstStage?.id ?? null,
      leadScore: result.leadScore,
      intentCategory: result.analysis.intentCategory,
      estimatedValueIdr: result.analysis.estimatedValueIdr,
      status: "open",
      waitingStatus: result.waitingStatus,
      productInterest: result.analysis.productInterest,
      aiNotes: result.analysis.aiNotes,
      lastActivityAt: new Date(),
    })
    .onConflictDoNothing({ target: opportunitiesTable.chatId })
    .returning({ id: opportunitiesTable.id });

  const opp = inserted[0];
  if (!opp) return; // An opportunity already existed for this chat — no-op.

  try {
    await db.insert(salesAuditEventsTable).values({
      ownerUserId: result.ownerUserId,
      opportunityId: opp.id,
      actorUserId: null,
      eventType: "opportunity_created",
      detail: {
        chatId: result.chatId,
        leadScore: result.leadScore,
        estimatedValueIdr: result.analysis.estimatedValueIdr,
        source: "ai_auto",
      },
    });
  } catch (err) {
    logger.warn(
      { err, chatId: result.chatId },
      "sales-detection: opportunity_created audit failed"
    );
  }

  logger.info(
    { chatId: result.chatId, opportunityId: opp.id, leadScore: result.leadScore },
    "sales-detection: auto-created opportunity"
  );
}

// Exported so the settings route can read the effective (defaulted) config.
export { getAutoCreateSettings };
