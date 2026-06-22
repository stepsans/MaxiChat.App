// Laporan & Jadwal — analytics v2 routes (spec section 9).
// Namespaced under /analytics/v2 so the legacy /analytics/summary is untouched.
// Every handler scopes to the effective owner and chains
// requirePermission("analytics", "view").

import { Router } from "express";
import type { Request, Response } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, reportAiCacheTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { getAllowedChannelIds } from "../lib/user-channel-access";
import { requirePermission } from "../lib/role-permissions";
import {
  resolvePeriod,
  computeSummary,
  computeAiPerformance,
  computeProductInterest,
  gatherAnomalyInputs,
  type PeriodKey,
} from "../lib/analytics-v2-metrics";
import { getInsight, type InsightType } from "../lib/report-ai-insights";
import { logger } from "../lib/logger";

const router: Router = Router();

async function owner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

function periodFromQuery(req: Request): { period: PeriodKey; from?: string; to?: string } {
  const period = (req.query.period as PeriodKey) || "today";
  return { period, from: req.query.from as string | undefined, to: req.query.to as string | undefined };
}

// Resolve the channel scope for the current viewer. Returns the list of channel
// ids the analytics must be restricted to:
//   • a specific `?channel=` (only if the viewer is allowed to see it — else 403)
//   • otherwise every channel the viewer may access (super_admin = all the
//     owner's channels; supervisor/agent = their user_channel_access set).
// Returns null when a response has already been sent (auth / forbidden), so the
// caller must bail. The list is ANDed against the owner predicate downstream;
// an empty list (e.g. an agent with no channel grants) yields zero rows.
async function channelScope(req: Request, res: Response): Promise<number[] | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  const allowed = await getAllowedChannelIds(uid);
  const raw = req.query.channel;
  if (raw != null && raw !== "" && raw !== "all") {
    const sel = Number(raw);
    if (!Number.isInteger(sel) || !allowed.has(sel)) {
      res.status(403).json({ error: "Channel tidak diizinkan" });
      return null;
    }
    return [sel];
  }
  return Array.from(allowed);
}

const view = requirePermission("analytics", "view");

router.get("/v2/summary", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const channelIds = await channelScope(req, res);
    if (channelIds == null) return;
    const { period, from, to } = periodFromQuery(req);
    const p = resolvePeriod(period, from, to);
    res.json(await computeSummary(ownerUserId, p, channelIds));
  } catch (err) {
    logger.error({ err }, "analytics v2 summary failed");
    res.status(500).json({ error: "Gagal memuat ringkasan" });
  }
});

router.get("/v2/ai-performance", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const channelIds = await channelScope(req, res);
    if (channelIds == null) return;
    const { period, from, to } = periodFromQuery(req);
    const p = resolvePeriod(period, from, to);
    res.json(await computeAiPerformance(ownerUserId, p, channelIds));
  } catch (err) {
    logger.error({ err }, "analytics v2 ai-performance failed");
    res.status(500).json({ error: "Gagal memuat performa AI" });
  }
});

router.get("/v2/chat-history", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const channelIds = await channelScope(req, res);
    if (channelIds == null) return;
    const { period, from, to } = periodFromQuery(req);
    const p = resolvePeriod(period, from, to);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const handledBy = (req.query.handledBy as string) || "all";
    const status = (req.query.status as string) || "all";
    const search = ((req.query.search as string) || "").trim();

    // Restrict to the viewer's channel scope (a single ?channel= or their full
    // allowed set). An empty set → IN () is invalid, so emit FALSE (no rows).
    const channelCond =
      channelIds.length === 0
        ? sql`FALSE`
        : sql`c.channel_id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})`;

    const conds = [
      sql`ch.user_id = ${ownerUserId}`,
      channelCond,
      sql`EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id AND cm.created_at >= ${p.start.toISOString()} AND cm.created_at < ${p.end.toISOString()})`,
    ];
    if (search) {
      const like = `%${search}%`;
      conds.push(sql`(c.contact_name ILIKE ${like} OR c.phone_number ILIKE ${like} OR c.last_message ILIKE ${like})`);
    }

    const whereSql = sql.join(conds, sql` AND `);

    // Enriched base with derived handledBy / status.
    const enriched = sql`
      WITH base AS (
        SELECT c.id AS chat_id, c.contact_name, c.phone_number, c.channel_id,
               ch.label AS channel_name, ch.kind AS channel_type,
               c.status, c.is_human_takeover, c.created_at AS started_at, c.last_message_at,
               (SELECT cm.direction FROM chat_messages cm WHERE cm.chat_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1) AS last_dir,
               EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id AND cm.sent_by_user_id IS NOT NULL) AS has_human_out,
               (SELECT MIN(cm.created_at) FROM chat_messages cm WHERE cm.chat_id = c.id) AS first_msg_at
        FROM chats c JOIN channels ch ON ch.id = c.channel_id
        WHERE ${whereSql}
      ),
      enriched AS (
        SELECT *,
          CASE WHEN status = 'needs_human' OR is_human_takeover THEN 'escalated'
               WHEN has_human_out THEN 'agent' ELSE 'ai' END AS handled_by,
          CASE WHEN status = 'closed' THEN 'done'
               WHEN last_dir = 'inbound' AND last_message_at < NOW() - INTERVAL '30 minutes' THEN 'unreplied'
               ELSE 'in_progress' END AS derived_status
        FROM base
      )`;

    const outerConds = [sql`TRUE`];
    if (handledBy !== "all") outerConds.push(sql`handled_by = ${handledBy}`);
    if (status !== "all") outerConds.push(sql`derived_status = ${status}`);
    const outerWhere = sql.join(outerConds, sql` AND `);

    const countRes = await db.execute(sql`${enriched} SELECT COUNT(*)::int AS n FROM enriched WHERE ${outerWhere}`);
    const total = Number((countRes.rows[0] as { n: number } | undefined)?.n ?? 0);

    const rowsRes = await db.execute(sql`
      ${enriched}
      SELECT chat_id, contact_name, phone_number, channel_id, channel_name, channel_type,
             handled_by, derived_status, started_at, last_message_at,
             CASE WHEN last_message_at IS NOT NULL AND first_msg_at IS NOT NULL
                  THEN GREATEST(0, EXTRACT(EPOCH FROM (last_message_at - first_msg_at))/60)::int END AS duration_minutes
      FROM enriched WHERE ${outerWhere}
      ORDER BY started_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const records = (rowsRes.rows as Array<Record<string, unknown>>).map((r) => ({
      chatId: Number(r.chat_id),
      contactName: String(r.contact_name ?? ""),
      phoneNumber: (r.phone_number as string) ?? null,
      channelId: Number(r.channel_id),
      channelName: String(r.channel_name ?? ""),
      channelType: String(r.channel_type ?? ""),
      handledBy: String(r.handled_by),
      durationMinutes: r.duration_minutes != null ? Number(r.duration_minutes) : null,
      satisfaction: null,
      status: String(r.derived_status),
      startedAt: new Date(r.started_at as string).toISOString(),
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string).toISOString() : null,
    }));

    res.json({ records, total, page, limit, hasMore: offset + records.length < total });
  } catch (err) {
    logger.error({ err }, "analytics v2 chat-history failed");
    res.status(500).json({ error: "Gagal memuat riwayat chat" });
  }
});

router.get("/v2/ai-insights", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const type = req.query.type as InsightType;
    if (!type || !["narrative", "anomaly", "kb_recommendations"].includes(type)) {
      res.status(400).json({ error: "type tidak valid" });
      return;
    }
    const period = ((req.query.period as PeriodKey) || "today") as PeriodKey;
    const refresh = req.query.refresh === "true" || req.query.refresh === "1";
    res.json(await getInsight(ownerUserId, type, period, refresh));
  } catch (err) {
    logger.error({ err }, "analytics v2 ai-insights failed");
    res.status(500).json({ error: "Gagal memuat insight AI" });
  }
});

router.get("/v2/next-actions", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const context = (req.query.context as string) || "summary";
    const items: Array<{ severity: "red" | "yellow" | "blue"; text: string; ctaText: string | null; ctaRoute: string | null }> = [];

    const today = resolvePeriod("today");
    const [summary, anomalyInputs] = await Promise.all([
      computeSummary(ownerUserId, today),
      gatherAnomalyInputs(ownerUserId),
    ]);

    // RED — urgent.
    if (summary.unrepliedCount > 0) {
      items.push({
        severity: "red",
        text: `${summary.unrepliedCount} chat belum dibalas lebih dari 30 menit`,
        ctaText: "Buka chat",
        ctaRoute: "/chats?filter=unread",
      });
    }
    if (anomalyInputs.avg7dEscalationPct > 0 && anomalyInputs.todayEscalationPct - anomalyInputs.avg7dEscalationPct > 20) {
      items.push({
        severity: "red",
        text: `Eskalasi AI naik ${anomalyInputs.todayEscalationPct - anomalyInputs.avg7dEscalationPct}% hari ini`,
        ctaText: "Lihat detail",
        ctaRoute: "/analytics?tab=ai",
      });
    }

    // YELLOW — attention. Surface a cached AI anomaly if present.
    const anomalyCache = await db
      .select()
      .from(reportAiCacheTable)
      .where(
        and(
          eq(reportAiCacheTable.ownerUserId, ownerUserId),
          eq(reportAiCacheTable.cacheKey, "anomaly_detection:today"),
          gt(reportAiCacheTable.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const anomalies = (anomalyCache[0]?.content as { anomalies?: Array<{ severity: string; text: string }> } | undefined)?.anomalies;
    if (anomalies?.length) {
      const top = anomalies.find((a) => a.severity === "critical") ?? anomalies[0];
      items.push({ severity: "yellow", text: top.text, ctaText: "Lihat insight AI", ctaRoute: "/analytics?tab=ai" });
    }

    // Failed schedule sends in the last 24h.
    const failed = await db.execute(sql`
      SELECT s.name FROM report_schedule_logs l
      JOIN report_schedules s ON s.id = l.schedule_id
      WHERE l.owner_user_id = ${ownerUserId} AND l.status = 'failed'
        AND l.created_at > NOW() - INTERVAL '1 day'
      ORDER BY l.created_at DESC LIMIT 1
    `);
    const failedName = (failed.rows[0] as { name: string } | undefined)?.name;
    if (failedName) {
      items.push({
        severity: "yellow",
        text: `Laporan '${failedName}' gagal terkirim`,
        ctaText: "Kirim ulang",
        ctaRoute: "/analytics?tab=schedule",
      });
    }

    // BLUE — informational. Schedules firing today.
    const dueToday = await db.execute(sql`
      SELECT name, send_time FROM report_schedules
      WHERE owner_user_id = ${ownerUserId} AND is_active = true
        AND next_scheduled_at IS NOT NULL
        AND (next_scheduled_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      ORDER BY next_scheduled_at ASC LIMIT 1
    `);
    const due = dueToday.rows[0] as { name: string; send_time: string } | undefined;
    if (due) {
      items.push({
        severity: "blue",
        text: `Laporan '${due.name}' akan dikirim jam ${due.send_time}`,
        ctaText: "Lihat jadwal",
        ctaRoute: "/analytics?tab=schedule",
      });
    }

    if (items.length === 0) {
      items.push({ severity: "blue", text: "Semua berjalan baik hari ini 👍", ctaText: null, ctaRoute: null });
    }

    // context is accepted for future tailoring; the unified list serves all tabs.
    void context;
    res.json(items);
  } catch (err) {
    logger.error({ err }, "analytics v2 next-actions failed");
    res.status(500).json({ error: "Gagal memuat langkah selanjutnya" });
  }
});

// Top Produk Diminati + Peluang Produk Baru (spec C.7/C.10). Aggregates the AI
// Pipeline analyses by product interest; product_in_catalog splits "Ada" vs the
// new-product demand surfaced in the "Peluang Produk Baru" card.
router.get("/v2/product-interest", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const channelIds = await channelScope(req, res);
    if (channelIds == null) return;
    const { period, from, to } = periodFromQuery(req);
    const p = resolvePeriod(period, from, to);
    res.json(await computeProductInterest(ownerUserId, p, period, channelIds));
  } catch (err) {
    logger.error({ err }, "analytics v2 product-interest failed");
    res.status(500).json({ error: "Gagal memuat minat produk" });
  }
});

export default router;
