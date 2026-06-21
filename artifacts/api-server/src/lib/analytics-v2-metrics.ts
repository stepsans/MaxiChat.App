import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { isInfinityOwner } from "./infinity-owner";

// ===========================================================================
// Laporan & Jadwal — shared metric computation.
//
// Every figure is computed LIVE from chats / chat_messages / channels, scoped
// to the tenant owner via channels.user_id = owner. Reused by both the
// analytics-v2 routes and the Claude insight generator so prompts and cards
// always agree. All time math is in WIB (UTC+7) to match the ACR engine.
// ===========================================================================

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export type PeriodKey = "today" | "7d" | "30d" | "custom";

export interface ResolvedPeriod {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  label: string;
}

/** Floor `d` to 00:00 WIB, returned as a UTC Date. */
function startOfWibDay(d: Date): Date {
  const shifted = new Date(d.getTime() + WIB_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - WIB_OFFSET_MS);
}

export function resolvePeriod(
  period: PeriodKey | undefined,
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedPeriod {
  if (period === "custom" && from && to) {
    const start = startOfWibDay(new Date(`${from}T00:00:00Z`));
    // inclusive end-of-day
    const end = new Date(startOfWibDay(new Date(`${to}T00:00:00Z`)).getTime() + 24 * 60 * 60 * 1000);
    const span = end.getTime() - start.getTime();
    return {
      start,
      end,
      prevStart: new Date(start.getTime() - span),
      prevEnd: start,
      label: `${from} – ${to}`,
    };
  }
  if (period === "7d") {
    const end = now;
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end, prevStart: new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000), prevEnd: start, label: "7 hari terakhir" };
  }
  if (period === "30d") {
    const end = now;
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { start, end, prevStart: new Date(start.getTime() - 30 * 24 * 60 * 60 * 1000), prevEnd: start, label: "30 hari terakhir" };
  }
  // default: today (WIB)
  const start = startOfWibDay(now);
  const end = now;
  const prevStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  return { start, end, prevStart, prevEnd: start, label: "Hari ini" };
}

function pctChange(curr: number, prev: number): number {
  if (prev === 0) return curr === 0 ? 0 : 100;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

// Optional channel scope, ANDed against the existing `ch.user_id = owner`
// predicate. `undefined` = all of the owner's channels (the tenant-wide default
// used by the cached AI insights — keeps their behavior unchanged). A list
// narrows to those channel ids; an empty list means no channels are in scope
// (zero rows). Callers resolve the list from the viewer's allowed channels.
function chFilter(channelIds?: number[]) {
  if (channelIds === undefined) return sql`TRUE`;
  if (channelIds.length === 0) return sql`FALSE`;
  return sql`ch.id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})`;
}

// --- Summary ----------------------------------------------------------------

export interface ChannelBreakdownItem {
  channelId: number;
  channelName: string;
  type: string;
  count: number;
  pct: number;
}

export interface SummaryMetrics {
  totalChats: number;
  totalChatsChange: number;
  aiHandledRate: number;
  aiHandledCount: number;
  avgResponseTimeSeconds: number;
  avgResponseTimeChange: number;
  unrepliedCount: number;
  channelBreakdown: ChannelBreakdownItem[];
  satisfactionBreakdown: { very_satisfied: number; satisfied: number; neutral: number; unsatisfied: number };
  hasSatisfactionData: boolean;
}

/** Distinct chats that received an inbound (customer) message in the window. */
async function countActiveChats(ownerUserId: number, start: Date, end: Date, channelIds?: number[]): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(DISTINCT cm.chat_id)::int AS n
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND cm.direction = 'inbound'
      AND cm.created_at >= ${start.toISOString()}
      AND cm.created_at < ${end.toISOString()}
  `);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Median first-response seconds across active chats in the window. */
async function medianFirstResponseSeconds(ownerUserId: number, start: Date, end: Date, channelIds?: number[]): Promise<number> {
  const res = await db.execute(sql`
    WITH first_in AS (
      SELECT cm.chat_id, MIN(cm.created_at) AS t_in
      FROM chat_messages cm
      JOIN chats c ON c.id = cm.chat_id
      JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.user_id = ${ownerUserId}
        AND ${chFilter(channelIds)}
        AND cm.direction = 'inbound'
        AND cm.created_at >= ${start.toISOString()}
        AND cm.created_at < ${end.toISOString()}
      GROUP BY cm.chat_id
    ),
    first_reply AS (
      SELECT fi.chat_id,
             (SELECT MIN(o.created_at) FROM chat_messages o
              WHERE o.chat_id = fi.chat_id AND o.direction = 'outbound' AND o.created_at >= fi.t_in) AS t_out,
             fi.t_in
      FROM first_in fi
    )
    SELECT COALESCE(
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t_out - t_in)))
    , 0)::int AS sec
    FROM first_reply
    WHERE t_out IS NOT NULL
  `);
  return Number((res.rows[0] as { sec: number } | undefined)?.sec ?? 0);
}

export async function computeSummary(
  ownerUserId: number,
  p: ResolvedPeriod,
  channelIds?: number[],
): Promise<SummaryMetrics> {
  const [totalChats, prevTotal] = await Promise.all([
    countActiveChats(ownerUserId, p.start, p.end, channelIds),
    countActiveChats(ownerUserId, p.prevStart, p.prevEnd, channelIds),
  ]);

  // AI-handled = the AI genuinely replied (message-level is_ai_generated) with no
  // human stepping in — NOT chats.status (defaults to 'ai_handled' and rarely
  // changes, which would count nearly every chat as AI-handled).
  const aiHandledCount = await countAiResolved(ownerUserId, p.start, p.end, channelIds);

  const [rt, prevRt] = await Promise.all([
    medianFirstResponseSeconds(ownerUserId, p.start, p.end, channelIds),
    medianFirstResponseSeconds(ownerUserId, p.prevStart, p.prevEnd, channelIds),
  ]);

  // Unreplied: latest message is inbound and older than 30 min (but within the
  // last 7 days so long-dead chats don't inflate the badge).
  const unrepliedRes = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM chats c
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND c.last_message_at < NOW() - INTERVAL '30 minutes'
      AND c.last_message_at > NOW() - INTERVAL '7 days'
      AND (
        SELECT cm.direction FROM chat_messages cm
        WHERE cm.chat_id = c.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT 1
      ) = 'inbound'
  `);
  const unrepliedCount = Number((unrepliedRes.rows[0] as { n: number } | undefined)?.n ?? 0);

  const chRes = await db.execute(sql`
    SELECT ch.id AS channel_id, ch.label AS channel_name, ch.kind AS type,
           COUNT(DISTINCT cm.chat_id)::int AS n
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND cm.direction = 'inbound'
      AND cm.created_at >= ${p.start.toISOString()} AND cm.created_at < ${p.end.toISOString()}
    GROUP BY ch.id, ch.label, ch.kind
    ORDER BY n DESC
  `);
  const channelBreakdown: ChannelBreakdownItem[] = (chRes.rows as Array<{ channel_id: number; channel_name: string; type: string; n: number }>).map((r) => ({
    channelId: Number(r.channel_id),
    channelName: r.channel_name,
    type: r.type,
    count: Number(r.n),
    pct: totalChats > 0 ? Math.round((Number(r.n) / totalChats) * 100) : 0,
  }));

  return {
    totalChats,
    totalChatsChange: pctChange(totalChats, prevTotal),
    aiHandledRate: totalChats > 0 ? Math.round((aiHandledCount / totalChats) * 1000) / 10 : 0,
    aiHandledCount,
    avgResponseTimeSeconds: rt,
    avgResponseTimeChange: pctChange(rt, prevRt),
    unrepliedCount,
    channelBreakdown,
    // No satisfaction rating exists in the schema yet — surface an empty state.
    satisfactionBreakdown: { very_satisfied: 0, satisfied: 0, neutral: 0, unsatisfied: 0 },
    hasSatisfactionData: false,
  };
}

// --- AI performance ---------------------------------------------------------

export interface EscalationTopic {
  topic: string;
  count: number;
  escalationRate: number;
}

export interface AiPerformanceMetrics {
  resolvedByAi: number;
  escalatedToAgent: number;
  escalatedCount: number;
  escalatedChange: number;
  avgSessionLength: number;
  tokensUsed: number;
  tokensRemaining: number;
  topEscalationTopics: EscalationTopic[];
}

// --- Authorship predicates (mirror ACR's isHumanMessage, acr-build.ts) -------
// A flow bot is NOT a human. "Human" = a dashboard send (sent_by_user_id set) OR
// a phone reply with NO automated signature; AI auto-reply, chatbot-flow, and
// follow-up automation are all bots. Anchored regex matches the tag suffix only
// (so a customer typing "Chatbot" mid-message is never misread). All fragments
// are correlated on the outer alias `c`.

// An outbound HUMAN reply to chat c within [start, end).
function humanReplyExists(start: Date, end: Date) {
  return sql`EXISTS (
    SELECT 1 FROM chat_messages o
    WHERE o.chat_id = c.id AND o.direction = 'outbound' AND o.is_ai_generated = false
      AND (o.sent_by_user_id IS NOT NULL
           OR COALESCE(o.content, '') !~ '_(Chatbot|powered by AI|follow-up otomatis)_[[:space:]]*$')
      AND o.created_at >= ${start.toISOString()} AND o.created_at < ${end.toISOString()}
  )`;
}

// An outbound BOT reply (AI auto-reply OR chatbot-flow / follow-up automation).
function botReplyExists(start: Date, end: Date) {
  return sql`EXISTS (
    SELECT 1 FROM chat_messages a
    WHERE a.chat_id = c.id AND a.direction = 'outbound'
      AND (a.is_ai_generated = true
           OR (a.sent_by_user_id IS NULL
               AND COALESCE(a.content, '') ~ '_(Chatbot|powered by AI|follow-up otomatis)_[[:space:]]*$'))
      AND a.created_at >= ${start.toISOString()} AND a.created_at < ${end.toISOString()}
  )`;
}

// At least one inbound (customer) message to chat c within [start, end).
function inboundExists(start: Date, end: Date) {
  return sql`EXISTS (
    SELECT 1 FROM chat_messages i
    WHERE i.chat_id = c.id AND i.direction = 'inbound'
      AND i.created_at >= ${start.toISOString()} AND i.created_at < ${end.toISOString()}
  )`;
}

// Chats a HUMAN had to handle in the window: an explicit takeover, OR a real
// human-authored outbound reply (see humanReplyExists). NOT derived from
// chats.status (defaults to 'ai_handled' and rarely changes).
async function countEscalated(ownerUserId: number, start: Date, end: Date, channelIds?: number[]): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(DISTINCT c.id)::int AS n
    FROM chats c
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND ${inboundExists(start, end)}
      AND (c.is_human_takeover = true OR ${humanReplyExists(start, end)})
  `);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}

// Chats GENUINELY resolved by a BOT (AI auto-reply OR chatbot flow): a bot
// replied, no human takeover, and NO human reply. A chat the bot never answered
// is NOT counted — fixing the old "total − escalated" formula that counted every
// non-escalated chat (incl. unanswered ones) as AI-resolved.
async function countAiResolved(ownerUserId: number, start: Date, end: Date, channelIds?: number[]): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(DISTINCT c.id)::int AS n
    FROM chats c
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND c.is_human_takeover = false
      AND ${inboundExists(start, end)}
      AND ${botReplyExists(start, end)}
      AND NOT ${humanReplyExists(start, end)}
  `);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}

const STOPWORDS = new Set([
  "yang","untuk","dengan","dari","pada","ini","itu","dan","atau","saya","kak","kakak","min","admin",
  "mau","bisa","tidak","gak","ga","ada","apa","gimana","bagaimana","kalau","aja","nya","sih","dong",
  "ya","iya","ok","oke","halo","hai","pak","bu","mbak","mas","kah","ke","di","yg","tk","the","is","to",
  "a","sudah","belum","juga","lagi","biar","tolong","mohon","terima","kasih","makasih","selamat",
]);

/** Lightweight keyword-frequency topics from escalated chats' inbound text. */
async function topEscalationTopics(ownerUserId: number, start: Date, end: Date, escalatedTotal: number, channelIds?: number[]): Promise<EscalationTopic[]> {
  const res = await db.execute(sql`
    SELECT cm.content
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND (c.is_human_takeover = true OR ${humanReplyExists(start, end)})
      AND cm.direction = 'inbound'
      AND cm.created_at >= ${start.toISOString()} AND cm.created_at < ${end.toISOString()}
      AND cm.content <> ''
    ORDER BY cm.created_at DESC
    LIMIT 400
  `);
  const counts = new Map<string, number>();
  for (const row of res.rows as Array<{ content: string }>) {
    const words = (row.content || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    for (const w of new Set(words)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({
      topic,
      count,
      escalationRate: escalatedTotal > 0 ? Math.round((count / escalatedTotal) * 100) : 0,
    }));
}

export async function computeAiPerformance(
  ownerUserId: number,
  p: ResolvedPeriod,
  channelIds?: number[],
): Promise<AiPerformanceMetrics> {
  const totalRes = await db.execute(sql`
    SELECT COUNT(DISTINCT cm.chat_id)::int AS n
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND cm.direction = 'inbound'
      AND cm.created_at >= ${p.start.toISOString()} AND cm.created_at < ${p.end.toISOString()}
  `);
  const total = Number((totalRes.rows[0] as { n: number } | undefined)?.n ?? 0);

  const [escalatedCount, prevEscalated, aiResolvedCount] = await Promise.all([
    countEscalated(ownerUserId, p.start, p.end, channelIds),
    countEscalated(ownerUserId, p.prevStart, p.prevEnd, channelIds),
    countAiResolved(ownerUserId, p.start, p.end, channelIds),
  ]);

  const msgRes = await db.execute(sql`
    SELECT COUNT(*)::int AS msgs
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND ${chFilter(channelIds)}
      AND cm.created_at >= ${p.start.toISOString()} AND cm.created_at < ${p.end.toISOString()}
  `);
  const totalMsgs = Number((msgRes.rows[0] as { msgs: number } | undefined)?.msgs ?? 0);

  // Token usage for the window + remaining quota.
  const tokRes = await db.execute(sql`
    SELECT COALESCE(SUM(total_tokens),0)::int AS used
    FROM ai_usage_events
    WHERE user_id = ${ownerUserId}
      AND created_at >= ${p.start.toISOString()} AND created_at < ${p.end.toISOString()}
  `);
  const tokensUsed = Number((tokRes.rows[0] as { used: number } | undefined)?.used ?? 0);

  let tokensRemaining = -1;
  if (!(await isInfinityOwner(ownerUserId))) {
    const qRes = await db.execute(sql`
      SELECT token_limit::int AS lim FROM tenant_quota WHERE user_id = ${ownerUserId} LIMIT 1
    `);
    const limit = Number((qRes.rows[0] as { lim: number } | undefined)?.lim ?? 0);
    if (limit > 0) {
      // Usage over the billing period is what the cap applies to; approximate
      // with the same window usage when limit is set (kept simple).
      const billRes = await db.execute(sql`
        SELECT COALESCE(SUM(total_tokens),0)::int AS used FROM ai_usage_events WHERE user_id = ${ownerUserId}
      `);
      const usedAll = Number((billRes.rows[0] as { used: number } | undefined)?.used ?? 0);
      tokensRemaining = Math.max(0, limit - usedAll);
    }
  }

  const topics = await topEscalationTopics(ownerUserId, p.start, p.end, escalatedCount, channelIds);

  return {
    resolvedByAi: total > 0 ? Math.round((aiResolvedCount / total) * 1000) / 10 : 0,
    escalatedToAgent: total > 0 ? Math.round((escalatedCount / total) * 1000) / 10 : 0,
    escalatedCount,
    escalatedChange: pctChange(escalatedCount, prevEscalated),
    avgSessionLength: total > 0 ? Math.round((totalMsgs / total) * 10) / 10 : 0,
    tokensUsed,
    tokensRemaining,
    topEscalationTopics: topics,
  };
}

// --- Anomaly inputs (today vs trailing 7-day average) -----------------------

export interface AnomalyInputs {
  todayChats: number;
  avg7dChats: number;
  todayEscalationPct: number;
  avg7dEscalationPct: number;
  todayResponseSec: number;
  avg7dResponseSec: number;
  volumeByHourToday: number[];
}

export async function gatherAnomalyInputs(ownerUserId: number, now: Date = new Date()): Promise<AnomalyInputs> {
  const today = resolvePeriod("today", undefined, undefined, now);
  const week = resolvePeriod("7d", undefined, undefined, now);

  const [todayChats, weekChats] = await Promise.all([
    countActiveChats(ownerUserId, today.start, today.end),
    countActiveChats(ownerUserId, week.start, week.end),
  ]);
  const [todayEsc, weekEsc] = await Promise.all([
    countEscalated(ownerUserId, today.start, today.end),
    countEscalated(ownerUserId, week.start, week.end),
  ]);
  const [todayRt, weekRt] = await Promise.all([
    medianFirstResponseSeconds(ownerUserId, today.start, today.end),
    medianFirstResponseSeconds(ownerUserId, week.start, week.end),
  ]);

  const hourRes = await db.execute(sql`
    SELECT EXTRACT(HOUR FROM (cm.created_at AT TIME ZONE 'Asia/Jakarta'))::int AS hr, COUNT(*)::int AS n
    FROM chat_messages cm
    JOIN chats c ON c.id = cm.chat_id
    JOIN channels ch ON ch.id = c.channel_id
    WHERE ch.user_id = ${ownerUserId}
      AND cm.direction = 'inbound'
      AND cm.created_at >= ${today.start.toISOString()} AND cm.created_at < ${today.end.toISOString()}
    GROUP BY hr ORDER BY hr
  `);
  const volumeByHourToday = Array(24).fill(0);
  for (const r of hourRes.rows as Array<{ hr: number; n: number }>) volumeByHourToday[Number(r.hr)] = Number(r.n);

  return {
    todayChats,
    avg7dChats: Math.round(weekChats / 7),
    todayEscalationPct: todayChats > 0 ? Math.round((todayEsc / todayChats) * 100) : 0,
    avg7dEscalationPct: weekChats > 0 ? Math.round((weekEsc / weekChats) * 100) : 0,
    todayResponseSec: todayRt,
    avg7dResponseSec: weekRt,
    volumeByHourToday,
  };
}
