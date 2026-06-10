import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  db,
  aiPipelinesTable,
  aiPipelineCutoffLogsTable,
  aiPipelineChannelsTable,
  aiPipelineExcludeLabelsTable,
  aiPipelineAnalysesTable,
  aiPipelineEntriesTable,
  chatsTable,
  chatMessagesTable,
  contactLabelsTable,
  channelsTable,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { createHash } from "crypto";
import { scheduleCutoffLogs } from "./ai-pipeline-scheduler";
import { createOpportunityFromAnalysis } from "./ai-pipeline-opportunity";
import { scheduleFollowups } from "./ai-pipeline-followup";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  buying_signal: number;  // 0-30
  urgency: number;        // 0-20
  engagement: number;     // 0-20
  commitment: number;     // 0-15
  product_fit: number;    // 0-10
  barrier_adjustment: number; // -5 to +5
}

interface AiAnalysisResult {
  score: number;
  scoreBreakdown: ScoreBreakdown;
  status: string;
  estimatedValue: number;
  productInterest: string;
  recommendation: string;
  scoreReason: string;
  aiNotes: string;
  contextHash: string;
  rawAnalysis: Record<string, unknown>;
}

// ─── Prompt builder ────────────────────────────────────────────────────────────

function buildAnalysisPrompt(
  transcript: string,
  contactName: string | null,
  channelType: string | null
): string {
  return `Kamu adalah AI analis penjualan untuk bisnis Indonesia. Analisa percakapan WhatsApp/Telegram berikut dan beri skor prospek secara objektif.

Nama kontak: ${contactName ?? "Tidak diketahui"}
Platform: ${channelType ?? "WhatsApp"}

TRANSKIP PERCAKAPAN:
${transcript}

Beri skor berdasarkan 6 dimensi:
1. buying_signal (0-30): Seberapa kuat sinyal pembelian (tanya harga, stok, minta penawaran, dll)
2. urgency (0-20): Tingkat urgensi (butuh segera, ada deadline, dll)
3. engagement (0-20): Seberapa aktif dan responsif dalam percakapan
4. commitment (0-15): Tanda-tanda komitmen (setuju harga, minta invoice, konfirmasi, dll)
5. product_fit (0-10): Seberapa cocok produk dengan kebutuhan yang disampaikan
6. barrier_adjustment (-5 to +5): Hambatan seperti keluhan harga, kompetitor, dll (negatif = hambatan besar)

Total skor = jumlah semua dimensi (0-100).

Balas HANYA dengan JSON valid (tanpa markdown, tanpa komentar):
{
  "score": <integer 0-100>,
  "scoreBreakdown": {
    "buying_signal": <integer 0-30>,
    "urgency": <integer 0-20>,
    "engagement": <integer 0-20>,
    "commitment": <integer 0-15>,
    "product_fit": <integer 0-10>,
    "barrier_adjustment": <integer -5 to 5>
  },
  "status": "<hot|warm|cold>",
  "estimatedValue": <integer dalam Rupiah, 0 jika tidak ada indikasi>,
  "productInterest": "<produk/jasa yang diminati, kosong jika tidak ada>",
  "recommendation": "<rekomendasi tindak lanjut, 1-2 kalimat>",
  "scoreReason": "<alasan skor dalam 1-2 kalimat>",
  "aiNotes": "<catatan tambahan relevan, kosong jika tidak ada>",
  "contextHash": "<3-5 kata kunci topik utama percakapan, dipisah koma>"
}`;
}

// ─── Main analysis runner ──────────────────────────────────────────────────────

export async function runCutoffAnalysis(cutoffLogId: number): Promise<void> {
  const log = await db.query.aiPipelineCutoffLogsTable.findFirst({
    where: eq(aiPipelineCutoffLogsTable.id, cutoffLogId),
  });
  if (!log) return;

  // Prevent double-run.
  if (log.status === "running" || log.status === "completed") return;

  await db
    .update(aiPipelineCutoffLogsTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));

  let contactsProcessed = 0;
  let contactsEnteredPipeline = 0;
  let opportunitiesCreated = 0;

  try {
    const pipeline = await db.query.aiPipelinesTable.findFirst({
      where: and(
        eq(aiPipelinesTable.id, log.pipelineId),
        eq(aiPipelinesTable.ownerUserId, log.ownerUserId),
        eq(aiPipelinesTable.isActive, true)
      ),
    });
    if (!pipeline) {
      await db.update(aiPipelineCutoffLogsTable)
        .set({ status: "completed", completedAt: new Date(), contactsProcessed: 0 })
        .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));
      return;
    }

    // Compute the window: from the previous cutoff time (or midnight) to this cutoff time.
    const windowEnd = log.scheduledTime;
    const windowStart = computeWindowStart(pipeline.cutoffTimes as string[], windowEnd);

    // Load all channels for this pipeline.
    const pipelineChannels = await db
      .select({ channelId: aiPipelineChannelsTable.channelId })
      .from(aiPipelineChannelsTable)
      .where(eq(aiPipelineChannelsTable.pipelineId, pipeline.id));

    if (pipelineChannels.length === 0) {
      await db.update(aiPipelineCutoffLogsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));
      return;
    }

    const channelIds = pipelineChannels.map((c) => c.channelId);

    // Load exclude labels for this pipeline.
    const excludeLabels = await db
      .select({ labelId: aiPipelineExcludeLabelsTable.labelId })
      .from(aiPipelineExcludeLabelsTable)
      .where(eq(aiPipelineExcludeLabelsTable.pipelineId, pipeline.id));
    const excludeLabelIds = excludeLabels.map((l) => l.labelId);

    // Resolve AI client once.
    const { client, model, provider, ownerUserId } = await resolveAiClient(pipeline.ownerUserId);

    // Find all chats in these channels that have had messages in the window.
    const activeChats = await db
      .selectDistinct({ chatId: chatMessagesTable.chatId })
      .from(chatMessagesTable)
      .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
      .where(
        and(
          inArray(chatsTable.channelId, channelIds),
          gte(chatMessagesTable.createdAt, windowStart),
          lte(chatMessagesTable.createdAt, windowEnd)
        )
      );

    if (activeChats.length === 0) {
      await db.update(aiPipelineCutoffLogsTable)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));
      return;
    }

    const activeChatIds = activeChats.map((c) => c.chatId);

    // Load chat details (phone, name, channelId).
    const chatRows = await db
      .select({
        id: chatsTable.id,
        phoneNumber: chatsTable.phoneNumber,
        contactName: chatsTable.contactName,
        channelId: chatsTable.channelId,
      })
      .from(chatsTable)
      .where(inArray(chatsTable.id, activeChatIds));

    // Build a set of excluded phone numbers (contacts with excluded labels).
    let excludedPhones = new Set<string>();
    if (excludeLabelIds.length > 0) {
      const excluded = await db
        .select({ phoneNumber: contactLabelsTable.phoneNumber })
        .from(contactLabelsTable)
        .where(
          and(
            eq(contactLabelsTable.ownerUserId, pipeline.ownerUserId),
            inArray(contactLabelsTable.labelId, excludeLabelIds)
          )
        );
      excludedPhones = new Set(excluded.map((e) => e.phoneNumber));
    }

    // Load channel types for the pipeline's channels.
    const channelTypeMap = new Map<number, string>();
    const channels = await db
      .select({ id: channelsTable.id, kind: channelsTable.kind })
      .from(channelsTable)
      .where(inArray(channelsTable.id, channelIds));
    for (const ch of channels) {
      channelTypeMap.set(ch.id, ch.kind);
    }

    // Process each chat.
    for (const chat of chatRows) {
      if (excludedPhones.has(chat.phoneNumber)) continue;

      try {
        const result = await analyzeChat({
          chat,
          pipelineId: pipeline.id,
          ownerUserId: pipeline.ownerUserId,
          windowStart,
          windowEnd,
          channelType: channelTypeMap.get(chat.channelId) ?? null,
          client,
          model,
          provider,
        });

        if (!result) continue;
        contactsProcessed++;

        // Persist analysis record.
        const [analysis] = await db.insert(aiPipelineAnalysesTable).values({
          pipelineId: pipeline.id,
          ownerUserId: pipeline.ownerUserId,
          contactPhone: chat.phoneNumber,
          contactName: chat.contactName,
          channelId: chat.channelId,
          channelType: channelTypeMap.get(chat.channelId) ?? null,
          cutoffDatetime: windowEnd,
          cutoffWindowStart: windowStart,
          cutoffWindowEnd: windowEnd,
          score: result.score,
          scoreBreakdown: result.scoreBreakdown,
          status: result.status,
          estimatedValue: result.estimatedValue || null,
          productInterest: result.productInterest || null,
          recommendation: result.recommendation || null,
          scoreReason: result.scoreReason || null,
          aiNotes: result.aiNotes || null,
          contextHash: result.contextHash || null,
          enteredPipeline: false,
          rawAnalysis: result.rawAnalysis,
        }).returning();

        // Apply pipeline entry rules (3 cases).
        const entryResult = await applyPipelineEntryRules({
          analysis,
          pipeline,
          windowEnd,
        });

        if (entryResult.entered) {
          contactsEnteredPipeline++;
        }

        // Auto-create opportunity if threshold exceeded.
        if (
          pipeline.autoCreateOpportunity &&
          result.score >= (pipeline.opportunityThreshold ?? 80) &&
          entryResult.entryId
        ) {
          try {
            await createOpportunityFromAnalysis({
              analysisId: analysis.id,
              entryId: entryResult.entryId,
              pipelineId: pipeline.id,
              ownerUserId: pipeline.ownerUserId,
              contactPhone: chat.phoneNumber,
              contactName: chat.contactName,
              channelId: chat.channelId,
              score: result.score,
              estimatedValue: result.estimatedValue || null,
              productInterest: result.productInterest || null,
              scoreReason: result.scoreReason || null,
              recommendation: result.recommendation || null,
            });
            opportunitiesCreated++;
          } catch (err) {
            // Non-fatal: opportunity creation is best-effort.
            console.error("[ai-pipeline] opportunity creation failed:", err);
          }
        }

        // Schedule follow-ups if enabled.
        if (
          pipeline.autoFollowupEnabled &&
          entryResult.entered &&
          entryResult.entryId &&
          result.score >= pipeline.scoreThreshold
        ) {
          try {
            await scheduleFollowups({
              entryId: entryResult.entryId,
              pipelineId: pipeline.id,
              ownerUserId: pipeline.ownerUserId,
              followupIntervals: (pipeline.followupIntervals as string[] | null) ?? ["24h", "48h", "72h"],
              currentFollowupCount: 0,
            });
          } catch (err) {
            console.error("[ai-pipeline] followup schedule failed:", err);
          }
        }
      } catch (err) {
        console.error("[ai-pipeline] chat analysis error for", chat.phoneNumber, err);
      }
    }

    // Update cutoff log with final stats.
    await db.update(aiPipelineCutoffLogsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        contactsProcessed,
        contactsEnteredPipeline,
        opportunitiesCreated,
      })
      .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));

    // Schedule the next 7 days of cutoff logs (idempotent).
    await scheduleCutoffLogs(
      pipeline.id,
      pipeline.ownerUserId,
      pipeline.cutoffTimes as string[]
    );
  } catch (err) {
    await db.update(aiPipelineCutoffLogsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        contactsProcessed,
        errorMessage: String(err),
      })
      .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));
    throw err;
  }
}

// ─── Per-chat analysis ─────────────────────────────────────────────────────────

async function analyzeChat(opts: {
  chat: { id: number; phoneNumber: string; contactName: string; channelId: number };
  pipelineId: number;
  ownerUserId: number;
  windowStart: Date;
  windowEnd: Date;
  channelType: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  model: string;
  provider: string;
}): Promise<AiAnalysisResult | null> {
  const { chat, windowStart, windowEnd, channelType, client, model, provider, ownerUserId } = opts;

  // Load messages in the window.
  const messages = await db
    .select({
      id: chatMessagesTable.id,
      direction: chatMessagesTable.direction,
      content: chatMessagesTable.content,
      senderName: chatMessagesTable.senderName,
      createdAt: chatMessagesTable.createdAt,
    })
    .from(chatMessagesTable)
    .where(
      and(
        eq(chatMessagesTable.chatId, chat.id),
        gte(chatMessagesTable.createdAt, windowStart),
        lte(chatMessagesTable.createdAt, windowEnd)
      )
    )
    .orderBy(chatMessagesTable.createdAt)
    .limit(80); // cap at 80 messages for token safety

  if (messages.length === 0) return null;

  // Build transcript.
  const transcript = messages
    .map((m) => {
      const who = m.direction === "outbound" ? "Bisnis" : "Pelanggan";
      const body = (m.content ?? "").trim();
      return `${who}: ${body || "[pesan media]"}`;
    })
    .join("\n");

  const prompt = buildAnalysisPrompt(transcript, chat.contactName, channelType);

  // Call AI.
  const completion = await (client.chat.completions.create as Function)({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1500,
    temperature: 0.1,
  }) as { choices: Array<{ message: { content: string }; finish_reason: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };

  const content = completion.choices?.[0]?.message?.content ?? "";

  // Track token usage (best-effort).
  try {
    await recordAiUsage({
      ownerUserId,
      channelId: opts.chat.channelId,
      provider,
      model,
      usage: completion.usage ?? null,
    });
  } catch { /* non-fatal */ }

  // Parse JSON response.
  let parsed: Record<string, unknown>;
  try {
    const jsonStr = content.replace(/^```json\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    console.error("[ai-pipeline] failed to parse AI response:", content.slice(0, 200));
    return null;
  }

  const bd = (parsed.scoreBreakdown ?? {}) as Record<string, number>;
  const breakdown: ScoreBreakdown = {
    buying_signal: clamp(bd.buying_signal, 0, 30),
    urgency: clamp(bd.urgency, 0, 20),
    engagement: clamp(bd.engagement, 0, 20),
    commitment: clamp(bd.commitment, 0, 15),
    product_fit: clamp(bd.product_fit, 0, 10),
    barrier_adjustment: clampSigned(bd.barrier_adjustment, -5, 5),
  };
  const computedScore = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, Math.max(0, typeof parsed.score === "number" ? parsed.score : computedScore));

  const contextHashRaw = typeof parsed.contextHash === "string" ? parsed.contextHash : "";
  const contextHash = createHash("md5")
    .update(contextHashRaw.toLowerCase().replace(/\s/g, ""))
    .digest("hex")
    .slice(0, 8);

  return {
    score,
    scoreBreakdown: breakdown,
    status: typeof parsed.status === "string" ? parsed.status : "cold",
    estimatedValue: typeof parsed.estimatedValue === "number" ? Math.max(0, Math.floor(parsed.estimatedValue)) : 0,
    productInterest: typeof parsed.productInterest === "string" ? parsed.productInterest : "",
    recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : "",
    scoreReason: typeof parsed.scoreReason === "string" ? parsed.scoreReason : "",
    aiNotes: typeof parsed.aiNotes === "string" ? parsed.aiNotes : "",
    contextHash,
    rawAnalysis: parsed,
  };
}

// ─── Pipeline entry rules ──────────────────────────────────────────────────────

async function applyPipelineEntryRules(opts: {
  analysis: typeof aiPipelineAnalysesTable.$inferSelect;
  pipeline: typeof aiPipelinesTable.$inferSelect;
  windowEnd: Date;
}): Promise<{ entered: boolean; entryId: number | null }> {
  const { analysis, pipeline, windowEnd } = opts;

  // Look up existing entry for this contact + pipeline.
  const existingEntry = await db.query.aiPipelineEntriesTable.findFirst({
    where: and(
      eq(aiPipelineEntriesTable.pipelineId, pipeline.id),
      eq(aiPipelineEntriesTable.contactPhone, analysis.contactPhone),
      eq(aiPipelineEntriesTable.channelId, analysis.channelId)
    ),
  });

  const scoreHistoryItem = {
    score: analysis.score,
    date: windowEnd.toISOString(),
    cutoffWindow: `${analysis.cutoffWindowStart.toISOString().slice(11, 16)}–${analysis.cutoffWindowEnd.toISOString().slice(11, 16)}`,
  };

  if (!existingEntry) {
    // Case 1: No existing entry.
    if (analysis.score >= pipeline.scoreThreshold) {
      // Create entry.
      const [entry] = await db.insert(aiPipelineEntriesTable).values({
        pipelineId: pipeline.id,
        analysisId: analysis.id,
        ownerUserId: pipeline.ownerUserId,
        contactPhone: analysis.contactPhone,
        contactName: analysis.contactName,
        channelId: analysis.channelId,
        channelType: analysis.channelType,
        currentScore: analysis.score,
        estimatedValue: analysis.estimatedValue,
        productInterest: analysis.productInterest,
        status: "new",
        followupCount: 0,
        scoreHistory: [scoreHistoryItem],
      }).returning();

      // Mark analysis as having entered the pipeline.
      await db.update(aiPipelineAnalysesTable)
        .set({ enteredPipeline: true, pipelineEntryId: entry.id })
        .where(eq(aiPipelineAnalysesTable.id, analysis.id));

      return { entered: true, entryId: entry.id };
    }
    return { entered: false, entryId: null };
  }

  // Case 2: Existing entry + score above threshold → update score.
  if (analysis.score >= pipeline.scoreThreshold) {
    const newHistory = [
      ...((existingEntry.scoreHistory as typeof scoreHistoryItem[]) ?? []),
      scoreHistoryItem,
    ].slice(-10); // keep last 10 entries

    await db.update(aiPipelineEntriesTable)
      .set({
        currentScore: analysis.score,
        estimatedValue: analysis.estimatedValue ?? existingEntry.estimatedValue,
        productInterest: analysis.productInterest ?? existingEntry.productInterest,
        analysisId: analysis.id,
        scoreHistory: newHistory,
        updatedAt: new Date(),
      })
      .where(eq(aiPipelineEntriesTable.id, existingEntry.id));

    await db.update(aiPipelineAnalysesTable)
      .set({ enteredPipeline: true, pipelineEntryId: existingEntry.id })
      .where(eq(aiPipelineAnalysesTable.id, analysis.id));

    return { entered: true, entryId: existingEntry.id };
  }

  // Case 3: Existing entry + score below threshold → update score history only, no pipeline flag.
  const newHistory = [
    ...((existingEntry.scoreHistory as typeof scoreHistoryItem[]) ?? []),
    scoreHistoryItem,
  ].slice(-10);

  await db.update(aiPipelineEntriesTable)
    .set({ currentScore: analysis.score, scoreHistory: newHistory, updatedAt: new Date() })
    .where(eq(aiPipelineEntriesTable.id, existingEntry.id));

  return { entered: false, entryId: existingEntry.id };
}

// ─── Window computation ────────────────────────────────────────────────────────

function computeWindowStart(cutoffTimes: string[], windowEnd: Date): Date {
  const sorted = [...cutoffTimes].sort();
  const endTime = `${String(windowEnd.getUTCHours()).padStart(2, "0")}:${String(windowEnd.getUTCMinutes()).padStart(2, "0")}`;

  // Find which index this cutoff corresponds to.
  const idx = sorted.findIndex((t) => t === endTime);
  if (idx === 0 || idx === -1) {
    // First cutoff of the day → window starts at midnight.
    const start = new Date(windowEnd);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }
  // Previous cutoff + 1 minute.
  const prevTime = sorted[idx - 1]!;
  const [ph, pm] = prevTime.split(":").map(Number);
  const start = new Date(windowEnd);
  start.setUTCHours(ph, pm + 1, 0, 0);
  return start;
}

// ─── Utility clamps ────────────────────────────────────────────────────────────

function clamp(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampSigned(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}
