import { db } from "@workspace/db";
import { reportAiCacheTable, knowledgeTable } from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { readCreditMeta } from "./ai-call-meta";
import { logger } from "./logger";
import {
  resolvePeriod,
  computeSummary,
  computeAiPerformance,
  gatherAnomalyInputs,
  type PeriodKey,
} from "./analytics-v2-metrics";

// ===========================================================================
// AI-insight generation for Laporan & Jadwal (spec sections 9.4 + 10).
// Three insight kinds — narrative, anomaly, kb_recommendations — each cached
// in report_ai_cache with a TTL. A cache miss regenerates via the CENTRALIZED
// AI engine (resolveAiClient → 4-engine priority failover + usage/credit
// accounting), so insights ride the same engine as the rest of the platform and
// we can surface WHICH engine served each insight for owner comparison.
// ===========================================================================

const ENGINE_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
  platform: "Mesin platform",
  replit: "OpenAI (Replit)",
  openrouter: "OpenRouter",
};

interface InsightCall {
  data: Record<string, unknown> | null;
  /** Friendly label of the engine that served this call, e.g. "Gemini · gemini-2.5-flash". */
  engine: string | null;
}

// Generate a JSON insight through the centralized AI client. Returns the parsed
// object plus the serving-engine label. Best-effort: never throws (returns
// {data: null} on any failure) so a card degrades gracefully.
async function callInsightJson(
  ownerUserId: number,
  system: string,
  user: string,
  maxTokens: number,
): Promise<InsightCall> {
  let resolved: Awaited<ReturnType<typeof resolveAiClient>>;
  try {
    resolved = await resolveAiClient(ownerUserId);
  } catch (err) {
    logger.error({ err, ownerUserId }, "insight AI: resolve client failed");
    return { data: null, engine: null };
  }
  const { client, model, provider } = resolved;
  // Floor the budget: thinking-capable models (e.g. gemini-2.5-flash) spend part
  // of max_tokens on internal reasoning, so a tight cap can starve / truncate
  // the JSON body. Give it room; insights are cached so the extra cost is rare.
  const budget = Math.max(maxTokens, 1500);
  let lastEngine: string | null = null;

  // Retry: models occasionally emit unparseable / truncated JSON. Note we do NOT
  // set response_format json_object — Gemini's OpenAI-compat endpoint rejects it
  // (400, wants 'json_schema'). temperature 0 + retries + a fence-tolerant parser
  // give reliable JSON across all engines instead.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model,
        max_tokens: budget,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      // The failover client tags the SERVING engine on `usage`; fall back to the
      // resolved provider on the managed/BYOK paths (no meta there).
      const servedEngine = readCreditMeta(res.usage)?.engine ?? provider;
      const servedModel = (res as { model?: string }).model || (model === "auto" ? "" : model);
      // Record usage against the owner (member usage rolls up) — same as every
      // other AI call site.
      void recordAiUsage({ ownerUserId, channelId: null, provider, model: servedModel || model, usage: res.usage });
      const label = ENGINE_LABELS[servedEngine] ?? servedEngine;
      lastEngine = servedModel ? `${label} · ${servedModel}` : label;
      const text = res.choices?.[0]?.message?.content;
      const parsed = extractJson(typeof text === "string" ? text : "");
      if (parsed) return { data: parsed, engine: lastEngine };
      logger.warn({ attempt, ownerUserId }, "insight AI: unparseable JSON response");
    } catch (err) {
      logger.error({ err, attempt, ownerUserId }, "insight AI call failed");
    }
  }
  return { data: null, engine: lastEngine };
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // Strip ``` / ```json code fences a model may wrap the JSON in.
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    // Last resort: drop trailing commas before } or ] which some models emit.
    try {
      return JSON.parse(slice.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export type InsightType = "narrative" | "anomaly" | "kb_recommendations";

const TTL_MS: Record<InsightType, number> = {
  narrative: 15 * 60_000,
  anomaly: 15 * 60_000,
  kb_recommendations: 30 * 60_000,
};

const CACHE_KEY: Record<InsightType, string> = {
  narrative: "insight_narrative",
  anomaly: "anomaly_detection",
  kb_recommendations: "kb_recommendations",
};

const SYSTEM_PROMPT = `Kamu adalah AI Analytics Assistant untuk platform customer service MaxiChat.
Tugasmu menganalisa data percakapan dan memberikan insight yang actionable dalam Bahasa Indonesia.

Selalu respons dalam format JSON yang valid. Tidak ada teks di luar JSON.
Semua teks harus ringkas, spesifik, dan langsung ke poin.
Hindari bahasa generik seperti "performa baik" tanpa data konkret.`;

export interface InsightResult {
  type: InsightType;
  generatedAt: string;
  expiresAt: string;
  fromCache: boolean;
  error: string | null;
  content: Record<string, unknown>;
  /** Friendly label of the AI engine that produced this insight (null on error). */
  engine: string | null;
}

function cacheKeyFor(type: InsightType, period: PeriodKey): string {
  return type === "narrative" || type === "anomaly" ? `${CACHE_KEY[type]}:${period}` : CACHE_KEY[type];
}

export async function getInsight(
  ownerUserId: number,
  type: InsightType,
  period: PeriodKey,
  refresh = false,
): Promise<InsightResult> {
  const key = cacheKeyFor(type, period);
  const now = new Date();

  if (!refresh) {
    const cached = await db
      .select()
      .from(reportAiCacheTable)
      .where(
        and(
          eq(reportAiCacheTable.ownerUserId, ownerUserId),
          eq(reportAiCacheTable.cacheKey, key),
          gt(reportAiCacheTable.expiresAt, now),
        ),
      )
      .limit(1);
    if (cached[0]) {
      return {
        type,
        generatedAt: cached[0].generatedAt.toISOString(),
        expiresAt: cached[0].expiresAt.toISOString(),
        fromCache: true,
        error: null,
        content: cached[0].content as Record<string, unknown>,
        engine: cached[0].engine ?? null,
      };
    }
  }

  let result: InsightCall;
  if (type === "narrative") result = await generateNarrative(ownerUserId, period);
  else if (type === "anomaly") result = await generateAnomaly(ownerUserId);
  else result = await generateKbRecommendations(ownerUserId, period);

  if (!result.data) {
    return {
      type,
      generatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
      fromCache: false,
      error: "Insight AI tidak tersedia saat ini. Coba muat ulang.",
      content: {},
      engine: null,
    };
  }

  const content = result.data;
  const engine = result.engine;
  const expiresAt = new Date(now.getTime() + TTL_MS[type]);
  // Upsert into the per-(owner,key) cache.
  await db
    .insert(reportAiCacheTable)
    .values({ ownerUserId, cacheKey: key, content, engine, generatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: [reportAiCacheTable.ownerUserId, reportAiCacheTable.cacheKey],
      set: { content, engine, generatedAt: now, expiresAt },
    });

  return {
    type,
    generatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    fromCache: false,
    error: null,
    content,
    engine,
  };
}

/** Clear cached insights for an owner — called when the Knowledge Base changes. */
export async function invalidateInsightCache(ownerUserId: number): Promise<void> {
  await db.delete(reportAiCacheTable).where(eq(reportAiCacheTable.ownerUserId, ownerUserId));
}

async function generateNarrative(ownerUserId: number, period: PeriodKey): Promise<InsightCall> {
  const p = resolvePeriod(period);
  const [summary, ai] = await Promise.all([
    computeSummary(ownerUserId, p),
    computeAiPerformance(ownerUserId, p),
  ]);
  const topics = ai.topEscalationTopics.map((t) => `- ${t.topic}: ${t.count} (${t.escalationRate}%)`).join("\n") || "- (tidak ada)";

  const user = `Berikut adalah data percakapan customer service untuk periode ${p.label}:

Total chat: ${summary.totalChats}
Chat diselesaikan AI: ${ai.resolvedByAi}%
Chat dieskalasi ke agent: ${ai.escalatedToAgent}%
Perubahan eskalasi vs periode sebelumnya: ${ai.escalatedChange}%
Waktu respons rata-rata: ${summary.avgResponseTimeSeconds} detik

Topik yang paling sering dieskalasi:
${topics}

Berikan insight dalam format JSON:
{
  "criticalIssue": "<1-2 kalimat masalah paling mendesak dengan angka konkret, atau null bila tidak ada>",
  "opportunity": "<1-2 kalimat peluang yang terdeteksi dari data, atau null bila tidak ada>",
  "positive": "<1-2 kalimat hal yang berjalan baik dengan angka konkret>",
  "totalChatsAnalyzed": ${summary.totalChats}
}`;

  return callInsightJson(ownerUserId, SYSTEM_PROMPT, user, 500);
}

async function generateAnomaly(ownerUserId: number): Promise<InsightCall> {
  const a = await gatherAnomalyInputs(ownerUserId);
  const user = `Berikut adalah data perbandingan performa customer service:

Data hari ini vs rata-rata 7 hari terakhir:
- Total chat: ${a.todayChats} vs ${a.avg7dChats}
- Eskalasi: ${a.todayEscalationPct}% vs ${a.avg7dEscalationPct}%
- Waktu respons: ${a.todayResponseSec}d vs ${a.avg7dResponseSec}d
- Volume per jam (hari ini): [${a.volumeByHourToday.join(", ")}]

Deteksi anomali yang signifikan. Hanya laporkan anomali yang benar-benar menonjol
(deviasi >20% dari rata-rata). Jangan laporkan variasi normal.

Respons dalam format JSON:
{
  "anomalies": [
    {
      "severity": "critical|warning|info",
      "text": "<deskripsi anomali dengan angka konkret>",
      "ctaText": "<teks tombol tindak lanjut>",
      "category": "escalation|volume|agent|sentiment"
    }
  ]
}

Bila tidak ada anomali yang signifikan, return: { "anomalies": [] }`;

  return callInsightJson(ownerUserId, SYSTEM_PROMPT, user, 600);
}

async function generateKbRecommendations(ownerUserId: number, period: PeriodKey): Promise<InsightCall> {
  const p = resolvePeriod(period);
  const ai = await computeAiPerformance(ownerUserId, p);
  const topics = ai.topEscalationTopics
    .map((t) => `- ${t.topic}: ${t.count} eskalasi (${t.escalationRate}% dari total eskalasi)`)
    .join("\n") || "- (tidak ada)";

  const kbRows = await db
    .select({ title: knowledgeTable.title })
    .from(knowledgeTable)
    .where(eq(knowledgeTable.userId, ownerUserId))
    .orderBy(sql`created_at DESC`)
    .limit(100);
  const kbList = kbRows.map((r) => `- ${r.title}`).join("\n") || "- (belum ada)";

  const user = `Berikut adalah topik yang paling sering menyebabkan eskalasi ke agent
(artinya AI tidak bisa menjawab sendiri):

${topics}

Knowledge Base yang sudah ada saat ini:
${kbList}

Rekomendasikan maksimal 3 topik yang paling perlu ditambahkan ke Knowledge Base
untuk mengurangi eskalasi. Prioritaskan yang impact-nya paling besar.

Respons dalam format JSON:
{
  "recommendations": [
    {
      "topic": "<nama topik yang direkomendasikan>",
      "reason": "<alasan singkat mengapa perlu ditambahkan>",
      "escalationRate": <persentase eskalasi terkait topik ini>,
      "estimatedImpact": "<estimasi pengurangan eskalasi bila ditambahkan>"
    }
  ]
}`;

  return callInsightJson(ownerUserId, SYSTEM_PROMPT, user, 400);
}
