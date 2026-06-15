import { db } from "@workspace/db";
import { reportAiCacheTable, knowledgeTable } from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { callClaudeJson, isClaudeConfigured } from "./claude";
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
// in report_ai_cache with a TTL; a cache miss regenerates via Claude.
// ===========================================================================

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
      };
    }
  }

  if (!isClaudeConfigured()) {
    return {
      type,
      generatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
      fromCache: false,
      error: "Insight AI tidak tersedia: ANTHROPIC_API_KEY belum dikonfigurasi.",
      content: {},
    };
  }

  let content: Record<string, unknown> | null = null;
  if (type === "narrative") content = await generateNarrative(ownerUserId, period);
  else if (type === "anomaly") content = await generateAnomaly(ownerUserId);
  else content = await generateKbRecommendations(ownerUserId, period);

  if (!content) {
    return {
      type,
      generatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
      fromCache: false,
      error: "Insight AI tidak tersedia saat ini. Coba muat ulang.",
      content: {},
    };
  }

  const expiresAt = new Date(now.getTime() + TTL_MS[type]);
  // Upsert into the per-(owner,key) cache.
  await db
    .insert(reportAiCacheTable)
    .values({ ownerUserId, cacheKey: key, content, generatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: [reportAiCacheTable.ownerUserId, reportAiCacheTable.cacheKey],
      set: { content, generatedAt: now, expiresAt },
    });

  return {
    type,
    generatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    fromCache: false,
    error: null,
    content,
  };
}

/** Clear cached insights for an owner — called when the Knowledge Base changes. */
export async function invalidateInsightCache(ownerUserId: number): Promise<void> {
  await db.delete(reportAiCacheTable).where(eq(reportAiCacheTable.ownerUserId, ownerUserId));
}

async function generateNarrative(ownerUserId: number, period: PeriodKey): Promise<Record<string, unknown> | null> {
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

  return callClaudeJson({ ownerUserId, system: SYSTEM_PROMPT, user, maxTokens: 500 });
}

async function generateAnomaly(ownerUserId: number): Promise<Record<string, unknown> | null> {
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

  return callClaudeJson({ ownerUserId, system: SYSTEM_PROMPT, user, maxTokens: 600 });
}

async function generateKbRecommendations(ownerUserId: number, period: PeriodKey): Promise<Record<string, unknown> | null> {
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

  return callClaudeJson({ ownerUserId, system: SYSTEM_PROMPT, user, maxTokens: 400 });
}
