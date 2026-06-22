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
  leadFeedbackTable,
  leadReviewRequestsTable,
  tenantAiMemoriesTable,
  tenantSettingsTable,
  productsTable,
} from "@workspace/db";
import { buildProductCatalogText } from "./product-catalog";
import { resolveAiClient } from "./ai-provider";
import { TokenQuotaExceededError } from "./ai-quota";
import { recordDeferredJob } from "./ai-deferred-jobs";
import { recordAiUsage } from "./ai-usage";
import { createHash } from "crypto";
import { scheduleCutoffLogs } from "./ai-pipeline-scheduler";
import { scheduleFollowups } from "./ai-pipeline-followup";
import { detectConversationRoleDbFree, detectIrrelevantDbFree, shouldSkipAsLearnedReverseRole } from "./ai-pipeline-prefilter";
import { decideReviewTrigger, buildLessonsBlock } from "./lead-learning";
import { getTzParts, zonedWallClockToUtc } from "./ai-pipeline-time";
import {
  getContactLeadStatus,
  setContactLeadStatusByAi,
} from "./contact-lead-status";
import { createOpportunityFromAi } from "./ai-pipeline-opportunity";

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
  // Catalog match: the product code the interest maps to (validated against the
  // tenant catalog so the model can't invent a code), and whether it exists in
  // the catalog. productInCatalog=false on a non-empty productInterest = demand
  // for a product the tenant doesn't sell yet.
  productMatchedCode: string | null;
  productInCatalog: boolean;
  recommendation: string;
  scoreReason: string;
  aiNotes: string;
  lastOpenPoint: string | null;
  stalledReason: string | null;
  // Customer's language register/tone, detected once so follow-ups stay consistent.
  customerTone: string | null;
  // Customer sentiment toward the service/product. Drives the "Customer Tidak
  // Puas" dashboard card (marah/kesal = dissatisfied). Defaults to "netral".
  sentiment: "marah" | "kesal" | "netral" | "senang";
  // Lead/role classification (§B.9 LANGKAH 0/1).
  conversationRole: "tenant_is_seller" | "tenant_is_buyer" | "unclear";
  leadClassification: "lead" | "not_lead" | "unclear";
  leadClassificationReason: string | null;
  // True when the AI says this should not enter the pipeline (reverse role).
  skipped: boolean;
  skipReason: string | null;
  contextHash: string;
  rawAnalysis: Record<string, unknown>;
}

// ─── Prompt builder ────────────────────────────────────────────────────────────

// Output contract appended to EVERY prompt (default or custom) so the parser at
// the call site never breaks, regardless of what the tenant writes. The 6
// dimensions + ranges stay fixed so `scoreThreshold` keeps a consistent meaning
// across pipelines even when the scoring *emphasis* is customized.
// LANGKAH 0/1 — tentukan role percakapan & klasifikasi lead SEBELUM skor.
// Ditempel ke setiap prompt (default & custom) sehingga klasifikasi konsisten
// apa pun persona scoring tenant.
const CLASSIFICATION_INSTRUCTION = `LANGKAH 0 — TENTUKAN ROLE PERCAKAPAN (WAJIB PERTAMA):
- AGENT/Bisnis (outbound) = pesan dari tenant kita. CUSTOMER/Pelanggan (inbound) = dari kontak.
- CARA MENENTUKAN SIAPA PENJUAL: pihak PENJUAL adalah yang MENERIMA pesanan & menagih — yang berkata "mau pesan apa?", menyebut "totalnya sekian", menyatakan cara/nomor pembayaran ("pembayaran hanya bisa tunai/transfer", "transfer ke rekening"), menanyakan "atas nama siapa", atau mengumumkan "pesanan sudah bisa diambil". Pihak PEMBELI adalah yang MENYAMPAIKAN pesanan & membayar — "saya pesan X", "bisa pesan?", "ok transfer".
- tenant_is_seller (NORMAL): AGENT (outbound) yang menerima pesanan/menagih/menyebut total; CUSTOMER (inbound) yang memesan & membayar.
- tenant_is_buyer (TERBALIK): KONTAK (inbound) yang menerima pesanan/menagih/menyebut total/menyatakan cara bayar/announce barang siap diambil, dan AGENT (outbound) yang memesan & membayar. Contoh: hotel konfirmasi reservasi AGENT, supplier kasih penawaran ke AGENT, ATAU warung/resto/toko (mis. martabak, kopi, makanan) tempat AGENT yang memesan. PENTING: jangan menilai aktivitas AGENT yang sedang MEMESAN sebagai "sinyal beli dari kontak". Bila terbaca terbalik → set conversation_role="tenant_is_buyer", lead_classification="not_lead", skip_pipeline=true, skip_reason singkat, score=0.

LANGKAH 1 — KLASIFIKASI LEAD (hanya bila tenant_is_seller):
- "lead": kontak menanyakan/berminat produk-layanan yang selaras dengan bisnis tenant.
- "not_lead": topik tidak terkait bisnis tenant / personal / rekanan non-komersial.
- "unclear": sinyal belum cukup.

`;

function buildOutputContract(): string {
  return `${CLASSIFICATION_INSTRUCTION}Beri skor berdasarkan 6 dimensi:
1. buying_signal (0-30): Seberapa kuat sinyal pembelian (tanya harga, stok, minta penawaran, dll)
2. urgency (0-20): Tingkat urgensi (butuh segera, ada deadline, dll)
3. engagement (0-20): Seberapa aktif dan responsif dalam percakapan
4. commitment (0-15): Tanda-tanda komitmen (setuju harga, minta invoice, konfirmasi, dll)
5. product_fit (0-10): Seberapa cocok produk dengan kebutuhan yang disampaikan
6. barrier_adjustment (-5 to +5): Hambatan seperti keluhan harga, kompetitor, dll (negatif = hambatan besar)

Total skor = jumlah semua dimensi (0-100).

PENCOCOKAN PRODUK (gunakan KATALOG PRODUK TENANT di atas, bila ada):
- productInterest = produk/jasa yang diminati customer, pakai kata customer apa adanya.
- productMatchedCode = kode (field "kode:") dari katalog yang paling cocok secara SEMANTIK dengan minat customer (mis. "printer uv a3" cocok dengan "Mesin UV DTF A3"). null bila tidak ada yang cocok atau katalog kosong. JANGAN mengarang kode yang tidak ada di katalog.
- productInCatalog = true bila productMatchedCode terisi (produk ADA di katalog), false bila customer meminta produk yang TIDAK ada di katalog.

Balas HANYA dengan JSON valid (tanpa markdown, tanpa komentar):
{
  "conversation_role": "tenant_is_seller" | "tenant_is_buyer" | "unclear",
  "lead_classification": "lead" | "not_lead" | "unclear",
  "lead_classification_reason": "<1 kalimat singkat, atau null>",
  "skip_pipeline": <true bila tenant_is_buyer, selain itu false>,
  "skip_reason": "<alasan bila skip_pipeline=true, atau null>",
  "score": <integer 0-100, 0 bila skip_pipeline=true>,
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
  "productInterest": "<produk/jasa yang diminati (kata customer apa adanya), kosong jika tidak ada>",
  "productMatchedCode": "<kode produk dari katalog yang cocok, atau null bila tidak ada>",
  "productInCatalog": <true bila productMatchedCode terisi, selain itu false>,
  "recommendation": "<rekomendasi tindak lanjut, 1-2 kalimat>",
  "scoreReason": "<alasan skor dalam 1-2 kalimat>",
  "aiNotes": "<catatan tambahan relevan, kosong jika tidak ada>",
  "lastOpenPoint": "<hal terakhir yang menggantung / pertanyaan customer yang belum tuntas dijawab / keberatan yang dia sampaikan. null kalau tidak ada yang jelas — JANGAN mengarang>",
  "stalledReason": "<alasan percakapan berhenti, sependek mungkin. null kalau tidak jelas>",
  "customerTone": "<gaya bahasa & nada CUSTOMER (bukan agent): pilih dari santai/akrab, sopan, formal, to-the-point — plus ciri spesifik bila ada (mis. 'pakai sapaan kak', 'banyak emoji', 'pakai singkatan', 'huruf kecil semua'). Contoh: 'santai & akrab, pakai kak + emoji'. null kalau pesan customer terlalu sedikit untuk dinilai. JANGAN mengarang>",
  "sentiment": "<sentimen CUSTOMER terhadap layanan/produk: pilih satu — marah | kesal | netral | senang. 'marah'=komplain keras / emosi kuat, 'kesal'=tidak puas / mengeluh ringan, 'netral'=biasa saja, 'senang'=puas / antusias. 'netral' bila tidak jelas — JANGAN mengarang>",
  "contextHash": "<3-5 kata kunci topik utama percakapan, dipisah koma>"
}`;
}

// Build the analysis prompt. When the pipeline has a custom guidance prompt it is
// injected as a clearly-labelled section that AUGMENTS (does not replace) the
// default persona, classification rules and 6-dimension rubric — those always
// come from the shared buildOutputContract() so the JSON output stays parseable.
function buildAnalysisPrompt(
  transcript: string,
  contactName: string | null,
  channelType: string | null,
  lessonsBlock: string,
  customPrompt?: string | null
): string {
  const customSection =
    customPrompt && customPrompt.trim().length > 0
      ? `\n=== PANDUAN KHUSUS PIPELINE INI (prioritaskan bila relevan) ===\n${customPrompt.trim()}\n`
      : "";

  return `Kamu adalah AI analis penjualan untuk bisnis Indonesia. Analisa percakapan WhatsApp/Telegram berikut dan beri skor prospek secara objektif.
${customSection}
Nama kontak: ${contactName ?? "Tidak diketahui"}
Platform: ${channelType ?? "WhatsApp"}

TRANSKIP PERCAKAPAN:
${transcript}

${lessonsBlock}${buildOutputContract()}`;
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
    const windowStart = computeWindowStart(
      pipeline.cutoffTimes as string[],
      windowEnd,
      pipeline.timezone
    );

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

    // Load tenant business profile + product catalog ONCE for the whole run —
    // every chat is judged against what this tenant actually sells. productCodes
    // is the authoritative set used to validate the model's catalog match.
    const [tenantSettings, productRows] = await Promise.all([
      db.query.tenantSettingsTable.findFirst({
        where: eq(tenantSettingsTable.ownerUserId, pipeline.ownerUserId),
        columns: { systemPrompt: true },
      }),
      db
        .select()
        .from(productsTable)
        .where(eq(productsTable.userId, pipeline.ownerUserId))
        .limit(200),
    ]);
    const systemPrompt = tenantSettings?.systemPrompt ?? null;
    const productCatalogText = buildProductCatalogText(productRows);
    const productCodes = new Set(productRows.map((p) => p.code.toUpperCase()));


    // Find all chats in these channels that have had messages in the window.
    // When directionFilter is on, a chat only qualifies if it received an
    // INBOUND message (customer → you) in the window — outbound-only chats are
    // skipped so the pipeline focuses on prospects who actually replied.
    const activeChats = await db
      .selectDistinct({ chatId: chatMessagesTable.chatId })
      .from(chatMessagesTable)
      .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
      .where(
        and(
          inArray(chatsTable.channelId, channelIds),
          gte(chatMessagesTable.createdAt, windowStart),
          lte(chatMessagesTable.createdAt, windowEnd),
          ...(pipeline.directionFilter
            ? [eq(chatMessagesTable.direction, "inbound")]
            : [])
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
          customPrompt: pipeline.customPrompt,
          systemPrompt,
          productCatalogText,
          productCodes,
          client,
          model,
          provider,
        });

        if (!result) continue;
        contactsProcessed++;

        // Record the prior score so the analysis row carries its delta — the
        // entry drawer renders previousScore → score as a trend. Most recent
        // analysis for the same contact + channel within this pipeline.
        const [prior] = await db
          .select({ score: aiPipelineAnalysesTable.score })
          .from(aiPipelineAnalysesTable)
          .where(
            and(
              eq(aiPipelineAnalysesTable.pipelineId, pipeline.id),
              eq(aiPipelineAnalysesTable.contactPhone, chat.phoneNumber),
              eq(aiPipelineAnalysesTable.channelId, chat.channelId)
            )
          )
          .orderBy(desc(aiPipelineAnalysesTable.createdAt))
          .limit(1);

        // Persist analysis record.
        const [analysis] = await db.insert(aiPipelineAnalysesTable).values({
          pipelineId: pipeline.id,
          ownerUserId: pipeline.ownerUserId,
          contactPhone: chat.phoneNumber,
          contactName: chat.contactName,
          channelId: chat.channelId,
          channelType: channelTypeMap.get(chat.channelId) ?? null,
          chatId: chat.id,
          cutoffDatetime: windowEnd,
          cutoffWindowStart: windowStart,
          cutoffWindowEnd: windowEnd,
          score: result.score,
          previousScore: prior?.score ?? null,
          scoreBreakdown: result.scoreBreakdown,
          status: result.status,
          estimatedValue: result.estimatedValue || null,
          productInterest: result.productInterest || null,
          productMatchedCode: result.productMatchedCode,
          productInCatalog: result.productInCatalog,
          recommendation: result.recommendation || null,
          scoreReason: result.scoreReason || null,
          aiNotes: result.aiNotes || null,
          lastOpenPoint: result.lastOpenPoint,
          stalledReason: result.stalledReason,
          customerTone: result.customerTone,
          sentiment: result.sentiment,
          conversationRole: result.conversationRole,
          leadClassification: result.leadClassification,
          leadClassificationReason: result.leadClassificationReason,
          skipped: result.skipped,
          skipReason: result.skipReason,
          contextHash: result.contextHash || null,
          enteredPipeline: false,
          rawAnalysis: result.rawAnalysis,
        }).returning();

        // Propagate the AI verdict to the contact-level status (never overrides a
        // manual classification — setContactLeadStatusByAi guards that).
        //  - skipped (reverse-role OR not_lead)        → not_lead. We key on
        //    `skipped` rather than `leadClassification` because the model often
        //    leaves lead_classification="unclear" while still flagging the chat
        //    as reverse-role/skip; an "unknown" contact must still become
        //    not_lead in that case.
        //  - a clear "lead"                            → lead.
        //  - genuinely unclear & not skipped           → leave the status alone.
        const propagatedStatus = result.skipped
          ? "not_lead"
          : result.leadClassification === "lead"
            ? "lead"
            : null;
        if (propagatedStatus) {
          try {
            await setContactLeadStatusByAi(
              pipeline.ownerUserId,
              chat.phoneNumber,
              propagatedStatus
            );
          } catch (err) {
            console.error("[ai-pipeline] lead status update failed:", err);
          }
        }

        // Ask the tenant when the AI is uncertain or conflicts with a manual
        // label. Runs even for skipped results (a skip can conflict with a
        // human 'lead'). The answer becomes a lesson the next run learns from.
        await maybeCreateReviewRequest({
          ownerUserId: pipeline.ownerUserId,
          chat,
          analysisId: analysis.id,
          scoreThreshold: pipeline.scoreThreshold,
          result,
          manual: await getContactLeadStatus(pipeline.ownerUserId, chat.phoneNumber),
        });

        // GUARD — skipped analyses (reverse role / not_lead) never enter the
        // pipeline and never auto-create opportunities.
        if (result.skipped) continue;

        // Apply pipeline entry rules (3 cases).
        const entryResult = await applyPipelineEntryRules({
          analysis,
          pipeline,
          windowEnd,
        });

        if (entryResult.entered) {
          contactsEnteredPipeline++;
        }

        // Auto-create opportunity when enabled and score crosses the threshold.
        if (
          pipeline.autoCreateOpportunity &&
          entryResult.entered &&
          result.score >= pipeline.opportunityThreshold
        ) {
          try {
            // The rules just (re)linked the entry; reflect it in memory so the
            // opportunity links back to the entry (entry.opportunity_id).
            analysis.pipelineEntryId = entryResult.entryId;
            await createOpportunityFromAi({ analysis, pipeline });
          } catch (err) {
            console.error("[ai-pipeline] opportunity auto-create failed:", err);
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
      })
      .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));

    // Schedule the next 7 days of cutoff logs (idempotent).
    await scheduleCutoffLogs(
      pipeline.id,
      pipeline.ownerUserId,
      pipeline.cutoffTimes as string[],
      pipeline.timezone
    );
  } catch (err) {
    // Token hard-block (spec C2): DEFER, don't fail. Reset the log to pending so
    // the cutoff scheduler re-runs it (with full re-validation) once quota
    // returns, and record the deferred-job state. Nothing is lost mid-window.
    if (err instanceof TokenQuotaExceededError) {
      await db.update(aiPipelineCutoffLogsTable)
        .set({ status: "pending", startedAt: null })
        .where(eq(aiPipelineCutoffLogsTable.id, cutoffLogId));
      await recordDeferredJob({
        ownerUserId: log.ownerUserId,
        jobType: "pipeline_cutoff",
        jobRef: cutoffLogId,
      });
      return;
    }
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
  customPrompt: string | null;
  // Tenant business profile + product catalog, fetched once per cut-off run and
  // shared across every chat so the model judges relevance/product-fit against
  // what this tenant actually sells. productCodes is the validated set of real
  // catalog codes — the model's productMatchedCode is rejected unless it's here.
  systemPrompt: string | null;
  productCatalogText: string;
  productCodes: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  model: string;
  provider: string;
}): Promise<AiAnalysisResult | null> {
  const { chat, windowStart, windowEnd, channelType, customPrompt, systemPrompt, productCatalogText, productCodes, client, model, provider, ownerUserId } = opts;

  // GUARD 1 — user manually marked this contact not_lead → skip entirely, no AI,
  // no analysis row (manual classification always wins). Returns null so the
  // caller simply moves on.
  const manualStatus = await getContactLeadStatus(ownerUserId, chat.phoneNumber);
  if (manualStatus?.leadStatus === "not_lead" && manualStatus.leadClassifiedBy === "manual") {
    return null;
  }

  // GUARD 1.5 — sticky reverse-role memory ("tambah lama tambah pintar"): once
  // any prior run concluded this contact is the seller / tenant the buyer, that
  // verdict is learned. Skip with zero AI tokens (still records a skipped row so
  // the memory stays fresh and auditable). A manual 'lead' override forces a
  // fresh analysis. Keyed on (owner, phone) so it follows the contact across
  // every channel — same key as the contact lead-status store.
  const priorRole = await getPriorConversationRole(ownerUserId, chat.phoneNumber);
  if (shouldSkipAsLearnedReverseRole(priorRole, manualStatus)) {
    return buildSkippedResult(
      "tenant_is_buyer",
      "Memori: kontak sudah dikenali sebagai penjual/vendor (tenant sebagai pembeli)"
    );
  }

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
    // Take the most recent 50 messages in the window (latest intent matters
    // most), then restore chronological order for the transcript.
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(50);
  messages.reverse();

  if (messages.length === 0) return null;

  // GUARD 2 — db-free pre-filter: reverse-role conversation (contact is the
  // seller, tenant is the buyer) → skip without spending AI tokens, but DO
  // record a skipped analysis row for auditability.
  if (detectConversationRoleDbFree(messages) === "tenant_is_buyer") {
    return buildSkippedResult(
      "tenant_is_buyer",
      "Pre-filter: kontak adalah supplier/vendor (tenant sebagai pembeli)"
    );
  }

  // GUARD 2b — db-free pre-filter: business-irrelevant topic (job seeker / spam
  // / academic research) → skip, mark not_lead, no AI tokens.
  if (detectIrrelevantDbFree(messages)) {
    return buildSkippedResult(
      "unclear",
      "Pre-filter: percakapan tidak relevan (pelamar kerja / spam / riset)"
    );
  }

  // Build transcript.
  const transcript = messages
    .map((m) => {
      const who = m.direction === "outbound" ? "Bisnis" : "Pelanggan";
      const body = (m.content ?? "").trim();
      return `${who}: ${body || "[pesan media]"}`;
    })
    .join("\n");

  // Tenant-taught memories (Learning Inbox chat) + few-shot lessons distilled
  // from past manual corrections — both make the model converge on this
  // tenant's definition over time ("tambah lama tambah pintar").
  const [memoryBlock, lessonsBlock] = await Promise.all([
    getTenantMemoryBlock(ownerUserId),
    getRecentLessonsBlock(ownerUserId),
  ]);

  // Business profile + product catalog (shared across the whole cut-off run).
  // Placed before the teaching/lessons block so the model anchors relevance and
  // product-fit on what the tenant actually sells. Both are optional — fall back
  // to a short note when absent rather than emitting an empty header.
  const businessProfile = (systemPrompt ?? "").trim();
  const businessBlock =
    `=== PROFIL BISNIS TENANT ===\n${businessProfile || "Tidak ada profil bisnis."}\n\n` +
    `=== KATALOG PRODUK TENANT ===\n${productCatalogText.trim() || "Tidak ada katalog produk terdaftar — gunakan profil bisnis saja."}\n\n`;

  const teachingBlock = `${businessBlock}${memoryBlock}${lessonsBlock}`;

  // A tenant-supplied custom prompt overrides the default scoring persona; the
  // system still appends the transcript + fixed JSON contract so output parses.
  // Empty/blank custom prompt → fall back to the hardcoded default (no change).
  const prompt = buildAnalysisPrompt(
    transcript,
    chat.contactName,
    channelType,
    teachingBlock,
    customPrompt
  );

  // Call AI. Retry up to 3 times with exponential backoff (§B.14) — transient
  // provider errors (rate limits, 5xx, dropped connections) shouldn't drop a
  // chat from the cut-off batch.
  type Completion = {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  let completion: Completion | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      completion = (await (client.chat.completions.create as Function)({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
        temperature: 0.1,
      })) as Completion;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  if (!completion) {
    console.error("[ai-pipeline] AI call failed after 3 attempts:", lastErr);
    return null;
  }

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

  // Lead/role classification (§B.9). A reverse role or explicit skip_pipeline
  // forces skipped=true and score 0 — it must never enter the pipeline.
  const conversationRole = parseEnum(parsed.conversation_role,
    ["tenant_is_seller", "tenant_is_buyer", "unclear"], "unclear");
  const leadClassification = parseEnum(parsed.lead_classification,
    ["lead", "not_lead", "unclear"], "unclear");
  const skipped =
    parsed.skip_pipeline === true ||
    conversationRole === "tenant_is_buyer" ||
    leadClassification === "not_lead";
  const skipReason = skipped
    ? (parseNullableText(parsed.skip_reason)
        ?? (conversationRole === "tenant_is_buyer"
          ? "Kontak adalah supplier/vendor — tenant berposisi sebagai pembeli"
          : "Diklasifikasi bukan lead"))
    : null;

  const score = skipped
    ? 0
    : Math.min(100, Math.max(0, typeof parsed.score === "number" ? parsed.score : computedScore));

  const contextHashRaw = typeof parsed.contextHash === "string" ? parsed.contextHash : "";
  const contextHash = createHash("md5")
    .update(contextHashRaw.toLowerCase().replace(/\s/g, ""))
    .digest("hex")
    .slice(0, 8);

  // Product catalog match. Validate the model's code against the real catalog so
  // a hallucinated code can never set productInCatalog=true. A non-empty interest
  // with no valid match → productInCatalog=false = new-product demand signal.
  const productInterest = typeof parsed.productInterest === "string" ? parsed.productInterest : "";
  const rawMatchedCode = parseNullableText(parsed.productMatchedCode);
  const productMatchedCode =
    rawMatchedCode && productCodes.has(rawMatchedCode.toUpperCase()) ? rawMatchedCode : null;
  const productInCatalog = productMatchedCode !== null;

  return {
    score,
    scoreBreakdown: breakdown,
    status: typeof parsed.status === "string" ? parsed.status : "cold",
    estimatedValue: typeof parsed.estimatedValue === "number" ? Math.max(0, Math.floor(parsed.estimatedValue)) : 0,
    productInterest,
    productMatchedCode,
    productInCatalog,
    recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : "",
    scoreReason: typeof parsed.scoreReason === "string" ? parsed.scoreReason : "",
    aiNotes: typeof parsed.aiNotes === "string" ? parsed.aiNotes : "",
    lastOpenPoint: parseNullableText(parsed.lastOpenPoint),
    stalledReason: parseNullableText(parsed.stalledReason),
    customerTone: parseNullableText(parsed.customerTone),
    sentiment: parseEnum(parsed.sentiment, ["marah", "kesal", "netral", "senang"], "netral"),
    conversationRole,
    leadClassification,
    leadClassificationReason: parseNullableText(parsed.lead_classification_reason),
    skipped,
    skipReason,
    contextHash,
    rawAnalysis: parsed,
  };
}

// Latest conversation_role this owner+contact was ever analyzed as (across all
// channels). Feeds the sticky reverse-role memory in GUARD 1.5. Returns null
// when the contact has never been analyzed before.
async function getPriorConversationRole(
  ownerUserId: number,
  contactPhone: string
): Promise<string | null> {
  const [row] = await db
    .select({ conversationRole: aiPipelineAnalysesTable.conversationRole })
    .from(aiPipelineAnalysesTable)
    .where(
      and(
        eq(aiPipelineAnalysesTable.ownerUserId, ownerUserId),
        eq(aiPipelineAnalysesTable.contactPhone, contactPhone)
      )
    )
    .orderBy(desc(aiPipelineAnalysesTable.createdAt))
    .limit(1);
  return row?.conversationRole ?? null;
}

// Per-tenant memories the owner taught via the Learning Inbox "Ajari AI" chat.
// Injected into every analysis prompt so the model follows this tenant's
// instructions/preferences. Empty string when there's nothing yet.
const MEMORY_LOOKBACK = 50;
async function getTenantMemoryBlock(ownerUserId: number): Promise<string> {
  try {
    const rows = await db
      .select({ content: tenantAiMemoriesTable.content })
      .from(tenantAiMemoriesTable)
      .where(
        and(
          eq(tenantAiMemoriesTable.ownerUserId, ownerUserId),
          eq(tenantAiMemoriesTable.archived, false)
        )
      )
      .orderBy(desc(tenantAiMemoriesTable.createdAt))
      .limit(MEMORY_LOOKBACK);
    if (rows.length === 0) return "";
    return `INSTRUKSI & PREFERENSI TENANT (diajarkan langsung oleh tenant — PATUHI ini saat menentukan conversation_role, lead_classification, dan skor):
${rows.map((r) => `- ${r.content}`).join("\n")}

`;
  } catch (err) {
    console.error("[ai-pipeline] tenant memory fetch failed:", err);
    return "";
  }
}

// Distil this owner's recent manual corrections into a compact prompt block.
const LESSONS_LOOKBACK = 25;
async function getRecentLessonsBlock(ownerUserId: number): Promise<string> {
  try {
    const rows = await db
      .select({
        fromStatus: leadFeedbackTable.fromStatus,
        toStatus: leadFeedbackTable.toStatus,
        reason: leadFeedbackTable.reason,
        contextSummary: leadFeedbackTable.contextSummary,
        aiConversationRole: leadFeedbackTable.aiConversationRole,
      })
      .from(leadFeedbackTable)
      .where(eq(leadFeedbackTable.ownerUserId, ownerUserId))
      .orderBy(desc(leadFeedbackTable.createdAt))
      .limit(LESSONS_LOOKBACK);
    return buildLessonsBlock(rows);
  } catch (err) {
    console.error("[ai-pipeline] lessons fetch failed:", err);
    return "";
  }
}

// Open a clarification request for the tenant when the AI is uncertain or its
// verdict conflicts with a manual label. Idempotent: the partial unique index
// (one 'pending' per owner+contact) plus a pre-check keep the queue from
// filling with duplicates.
async function maybeCreateReviewRequest(opts: {
  ownerUserId: number;
  chat: { id: number; phoneNumber: string; contactName: string; channelId: number };
  analysisId: number;
  scoreThreshold: number;
  result: AiAnalysisResult;
  manual: { leadStatus: string; leadClassifiedBy: string } | null;
}): Promise<void> {
  const { ownerUserId, chat, analysisId, scoreThreshold, result, manual } = opts;
  const decision = decideReviewTrigger({
    contactName: chat.contactName,
    score: result.score,
    scoreThreshold,
    conversationRole: result.conversationRole,
    skipped: result.skipped,
    leadClassification: result.leadClassification,
    manual,
  });
  if (!decision.needsReview) return;

  try {
    const [existing] = await db
      .select({ id: leadReviewRequestsTable.id })
      .from(leadReviewRequestsTable)
      .where(
        and(
          eq(leadReviewRequestsTable.ownerUserId, ownerUserId),
          eq(leadReviewRequestsTable.contactPhone, chat.phoneNumber),
          eq(leadReviewRequestsTable.status, "pending")
        )
      )
      .limit(1);
    if (existing) return;

    await db.insert(leadReviewRequestsTable).values({
      ownerUserId,
      contactPhone: chat.phoneNumber,
      contactName: chat.contactName,
      chatId: chat.id,
      channelId: chat.channelId,
      analysisId,
      trigger: decision.trigger!,
      question: decision.question ?? "Lead atau bukan?",
      aiSuggestedStatus: decision.aiSuggestedStatus,
      aiScore: result.score,
      aiConversationRole: result.conversationRole,
      contextSummary: result.productInterest || result.scoreReason || null,
    });
  } catch (err) {
    // Unique-violation race (another worker opened the same request) is benign.
    console.error("[ai-pipeline] review request create skipped:", err);
  }
}

// Build a zero-score skipped analysis result (no AI call) for reverse-role /
// not-lead conversations. Inserted for auditability; never enters the pipeline.
function buildSkippedResult(
  conversationRole: AiAnalysisResult["conversationRole"],
  skipReason: string
): AiAnalysisResult {
  return {
    score: 0,
    scoreBreakdown: {
      buying_signal: 0, urgency: 0, engagement: 0,
      commitment: 0, product_fit: 0, barrier_adjustment: 0,
    },
    status: "Tidak relevan",
    estimatedValue: 0,
    productInterest: "",
    productMatchedCode: null,
    productInCatalog: false,
    recommendation: "",
    scoreReason: "",
    aiNotes: "",
    lastOpenPoint: null,
    stalledReason: null,
    customerTone: null,
    sentiment: "netral",
    conversationRole,
    leadClassification: "not_lead",
    leadClassificationReason: skipReason,
    skipped: true,
    skipReason,
    contextHash: "",
    rawAnalysis: { prefilter: true, conversationRole, skipReason },
  };
}

// Coerce an unknown into one of the allowed enum strings, with a fallback.
function parseEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === "string" && (allowed as string[]).includes(v)
    ? (v as T)
    : fallback;
}

// Parse an optional analysis text field. The model is told to return null when
// there is nothing concrete; we also treat empty / literal "null" as absent so a
// fabricated-but-blank value never becomes a follow-up anchor.
function parseNullableText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "null") return null;
  return t;
}

// ─── Pipeline entry rules ──────────────────────────────────────────────────────

// Insert a brand-new pipeline entry from a qualifying analysis and mark the
// analysis as entered. Shared by the no-entry case and the >7-day re-entry paths
// (closed deals / customer opt-out that re-engaged after a long gap).
async function createFreshEntry(opts: {
  analysis: typeof aiPipelineAnalysesTable.$inferSelect;
  pipeline: typeof aiPipelinesTable.$inferSelect;
  scoreHistoryItem: { score: number; date: string; cutoffWindow: string };
}): Promise<{ entered: boolean; entryId: number }> {
  const { analysis, pipeline, scoreHistoryItem } = opts;
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

  await db.update(aiPipelineAnalysesTable)
    .set({ enteredPipeline: true, pipelineEntryId: entry.id })
    .where(eq(aiPipelineAnalysesTable.id, analysis.id));

  return { entered: true, entryId: entry.id };
}

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
    // Case 1: No existing entry — create one if it clears the threshold.
    if (analysis.score >= pipeline.scoreThreshold) {
      return await createFreshEntry({ analysis, pipeline, scoreHistoryItem });
    }
    return { entered: false, entryId: null };
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  // ── CASE B — special existing-entry states (handled before the generic update).

  // (a) Customer hard-stop: honor the opt-out. Only renewed qualifying interest
  //     after a >7-day gap is treated as a fresh intent (brand-new entry).
  if (existingEntry.doNotFollowup && existingEntry.followupStoppedBy === "customer") {
    const ref = existingEntry.doNotFollowupAt ?? existingEntry.updatedAt;
    const reEngaged = windowEnd.getTime() - ref.getTime() > SEVEN_DAYS_MS;
    if (reEngaged && analysis.score >= pipeline.scoreThreshold) {
      return await createFreshEntry({ analysis, pipeline, scoreHistoryItem });
    }
    return { entered: false, entryId: existingEntry.id };
  }

  // (b) Closed deal (won/lost): a >7-day gap with renewed qualifying interest
  //     opens a new entry; otherwise the closed record is left untouched.
  if (existingEntry.status === "closed_won" || existingEntry.status === "closed_lost") {
    const reEngaged = windowEnd.getTime() - existingEntry.updatedAt.getTime() > SEVEN_DAYS_MS;
    if (reEngaged && analysis.score >= pipeline.scoreThreshold) {
      return await createFreshEntry({ analysis, pipeline, scoreHistoryItem });
    }
    return { entered: false, entryId: existingEntry.id };
  }

  // (c) Operator-stopped follow-up: NOT a blacklist. AI keeps scoring the same
  //     entry; auto follow-up stays muted (doNotFollowup/followupStoppedBy
  //     untouched) until the operator re-enables it manually.
  if (existingEntry.doNotFollowup && existingEntry.followupStoppedBy === "user") {
    const newHistory = [
      ...((existingEntry.scoreHistory as typeof scoreHistoryItem[]) ?? []),
      scoreHistoryItem,
    ].slice(-10);
    const above = analysis.score >= pipeline.scoreThreshold;
    await db.update(aiPipelineEntriesTable)
      .set({
        currentScore: analysis.score,
        estimatedValue: analysis.estimatedValue ?? existingEntry.estimatedValue,
        productInterest: analysis.productInterest ?? existingEntry.productInterest,
        analysisId: analysis.id,
        scoreHistory: newHistory,
        // Reactivate visibility when warm again, but keep auto follow-up muted.
        status: above ? "in_progress" : existingEntry.status,
        cooled: above ? false : true,
        cooledAt: above ? null : existingEntry.cooled ? existingEntry.cooledAt : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiPipelineEntriesTable.id, existingEntry.id));
    await db.update(aiPipelineAnalysesTable)
      .set({ enteredPipeline: true, pipelineEntryId: existingEntry.id })
      .where(eq(aiPipelineAnalysesTable.id, analysis.id));
    return { entered: above, entryId: existingEntry.id };
  }

  // Case 2: Existing active entry + score above threshold → update score.
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
        // Score recovered to/above threshold → lead is warm again.
        cooled: false,
        cooledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(aiPipelineEntriesTable.id, existingEntry.id));

    await db.update(aiPipelineAnalysesTable)
      .set({ enteredPipeline: true, pipelineEntryId: existingEntry.id })
      .where(eq(aiPipelineAnalysesTable.id, analysis.id));

    return { entered: true, entryId: existingEntry.id };
  }

  // Case 3: Existing entry + score below threshold. The entry stays in the
  // pipeline (sticky) but is flagged as cooled so the team can see/filter leads
  // that have gone cold. Preserve the original cooledAt if already cooled.
  const newHistory = [
    ...((existingEntry.scoreHistory as typeof scoreHistoryItem[]) ?? []),
    scoreHistoryItem,
  ].slice(-10);

  await db.update(aiPipelineEntriesTable)
    .set({
      currentScore: analysis.score,
      scoreHistory: newHistory,
      cooled: true,
      cooledAt: existingEntry.cooled ? existingEntry.cooledAt : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiPipelineEntriesTable.id, existingEntry.id));

  return { entered: false, entryId: existingEntry.id };
}

// ─── Window computation ────────────────────────────────────────────────────────

function computeWindowStart(cutoffTimes: string[], windowEnd: Date, timeZone: string): Date {
  const sorted = [...cutoffTimes].sort();
  // windowEnd is a UTC instant; match it against the cutoff strings by its
  // wall-clock value in the pipeline's timezone.
  const end = getTzParts(windowEnd, timeZone);
  const endTime = `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`;

  // Find which index this cutoff corresponds to.
  const idx = sorted.findIndex((t) => t === endTime);
  if (idx === 0 || idx === -1) {
    // First cutoff of the day → window starts at tz midnight that day.
    return zonedWallClockToUtc(end.year, end.month, end.day, 0, 0, timeZone);
  }
  // Previous cutoff + 1 minute (minute 60 normalizes to the next hour).
  const prevTime = sorted[idx - 1]!;
  const [ph, pm] = prevTime.split(":").map(Number);
  return zonedWallClockToUtc(end.year, end.month, end.day, ph ?? 0, (pm ?? 0) + 1, timeZone);
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
