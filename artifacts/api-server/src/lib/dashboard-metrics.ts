import {
  and,
  eq,
  gte,
  lte,
  inArray,
  sql,
  desc,
  countDistinct,
} from "drizzle-orm";
import {
  db,
  chatsTable,
  chatMessagesTable,
  aiPipelineAnalysesTable,
  chatbotFlowEventsTable,
  chatbotFlowsTable,
  opportunitiesTable,
} from "@workspace/db";

// Pure-ish metric queries for the Dashboard (spec §4). Every query is scoped to a
// set of allowed channel ids (already owner+permission resolved by the caller).
// "Range" metrics bound on activity/creation time; "current" metrics (waiting,
// my active chats, lead status snapshot) reflect present state — documented per
// function.

export interface DashboardRange {
  from: Date;
  to: Date;
}

// Empty allowed set must yield zeros, never an unscoped query.
function noChannels(allowed: Set<number>): boolean {
  return allowed.size === 0;
}

// SQL fragment: the direction of a chat's most recent message. Used to derive
// waiting status (inbound last = company must reply = "waiting_company").
const lastDirection = sql<string>`(
  SELECT m.direction FROM ${chatMessagesTable} m
  WHERE m.chat_id = ${chatsTable.id}
  ORDER BY m.id DESC LIMIT 1
)`;

// ── Percakapan: distinct chats with ≥1 message in range (+ previous period) ──
export async function conversationCount(
  allowed: Set<number>,
  range: DashboardRange
): Promise<{ count: number; previous: number; delta: number }> {
  if (noChannels(allowed)) return { count: 0, previous: 0, delta: 0 };
  const ids = [...allowed];
  const lengthMs = range.to.getTime() - range.from.getTime();
  const prevFrom = new Date(range.from.getTime() - lengthMs);

  async function inWindow(from: Date, to: Date): Promise<number> {
    const [row] = await db
      .select({ n: countDistinct(chatMessagesTable.chatId) })
      .from(chatMessagesTable)
      .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
      .where(
        and(
          inArray(chatsTable.channelId, ids),
          gte(chatMessagesTable.createdAt, from),
          lte(chatMessagesTable.createdAt, to)
        )
      );
    return row?.n ?? 0;
  }

  const count = await inWindow(range.from, range.to);
  const previous = await inWindow(prevFrom, range.from);
  return { count, previous, delta: count - previous };
}

// ── Belum dibalas (CS): chats whose last message is inbound = waiting_company.
// CURRENT snapshot (range-independent), excludes archived chats.
export async function waitingCompanyCount(allowed: Set<number>): Promise<number> {
  if (noChannels(allowed)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatsTable)
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        eq(chatsTable.isArchived, false),
        sql`${lastDirection} = 'inbound'`
      )
    );
  return row?.n ?? 0;
}

// ── Avg first response time (seconds): firstAgentReplyAt − createdAt over chats
// whose first agent reply landed in range. createdAt ≈ first inbound (chat is
// created on the first message). Human reply only (firstAgentReplyAt is the first
// outbound by the assigned agent).
export async function avgFirstResponseSeconds(
  allowed: Set<number>,
  range: DashboardRange
): Promise<number | null> {
  if (noChannels(allowed)) return null;
  const [row] = await db
    .select({
      avg: sql<number | null>`avg(extract(epoch from (${chatsTable.firstAgentReplyAt} - ${chatsTable.createdAt})))`,
    })
    .from(chatsTable)
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        sql`${chatsTable.firstAgentReplyAt} IS NOT NULL`,
        gte(chatsTable.firstAgentReplyAt, range.from),
        lte(chatsTable.firstAgentReplyAt, range.to)
      )
    );
  return row?.avg != null ? Math.round(Number(row.avg)) : null;
}

// ── Ditangani AI (%): outbound AI-generated vs all outbound, in range.
export async function aiHandledPercent(
  allowed: Set<number>,
  range: DashboardRange
): Promise<number | null> {
  if (noChannels(allowed)) return null;
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      ai: sql<number>`count(*) filter (where ${chatMessagesTable.isAiGenerated} = true)::int`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        eq(chatMessagesTable.direction, "outbound"),
        gte(chatMessagesTable.createdAt, range.from),
        lte(chatMessagesTable.createdAt, range.to)
      )
    );
  const total = row?.total ?? 0;
  if (total === 0) return null;
  return Math.round(((row?.ai ?? 0) / total) * 100);
}

// ── Chat aktif saya (agent): chats assigned to this user, not archived. CURRENT.
export async function myActiveChatCount(
  allowed: Set<number>,
  agentUserId: number
): Promise<number> {
  if (noChannels(allowed)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatsTable)
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        eq(chatsTable.assignedUserId, agentUserId),
        eq(chatsTable.isArchived, false)
      )
    );
  return row?.n ?? 0;
}

// ── Lead panas: analyses scored ≥ 80 in range.
export async function hotLeadCount(
  allowed: Set<number>,
  range: DashboardRange
): Promise<number> {
  if (noChannels(allowed)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiPipelineAnalysesTable)
    .where(
      and(
        inArray(aiPipelineAnalysesTable.channelId, [...allowed]),
        gte(aiPipelineAnalysesTable.score, 80),
        gte(aiPipelineAnalysesTable.createdAt, range.from),
        lte(aiPipelineAnalysesTable.createdAt, range.to)
      )
    );
  return row?.n ?? 0;
}

// ── Customer Tidak Puas: analyses with sentiment in ('marah','kesal') in range.
// (Sentiment populated from Phase 3; until then this returns 0.)
export async function dissatisfiedCount(
  allowed: Set<number>,
  range: DashboardRange
): Promise<number> {
  if (noChannels(allowed)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiPipelineAnalysesTable)
    .where(
      and(
        inArray(aiPipelineAnalysesTable.channelId, [...allowed]),
        inArray(aiPipelineAnalysesTable.sentiment, ["marah", "kesal"]),
        gte(aiPipelineAnalysesTable.createdAt, range.from),
        lte(aiPipelineAnalysesTable.createdAt, range.to)
      )
    );
  return row?.n ?? 0;
}

// ── Lead Status: chats grouped by lead_status, created in range.
export async function leadStatusCounts(
  allowed: Set<number>,
  range: DashboardRange
): Promise<{ lead: number; not_lead: number; unknown: number }> {
  const base = { lead: 0, not_lead: 0, unknown: 0 };
  if (noChannels(allowed)) return base;
  const rows = await db
    .select({
      leadStatus: chatsTable.leadStatus,
      n: sql<number>`count(*)::int`,
    })
    .from(chatsTable)
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        gte(chatsTable.createdAt, range.from),
        lte(chatsTable.createdAt, range.to)
      )
    )
    .groupBy(chatsTable.leadStatus);
  for (const r of rows) {
    if (r.leadStatus === "lead") base.lead = r.n;
    else if (r.leadStatus === "not_lead") base.not_lead = r.n;
    else base.unknown += r.n;
  }
  return base;
}

// ── Drill-down lists behind a metric card. Returns chat rows for the metric.
export interface DrillRow {
  chatId: number;
  contactName: string;
  phoneNumber: string;
  channelId: number;
  status: string;
  leadStatus: string;
  lastMessage: string | null;
  lastMessageAt: Date | null;
}

const DRILL_COLS = {
  chatId: chatsTable.id,
  contactName: chatsTable.contactName,
  phoneNumber: chatsTable.phoneNumber,
  channelId: chatsTable.channelId,
  status: chatsTable.status,
  leadStatus: chatsTable.leadStatus,
  lastMessage: chatsTable.lastMessage,
  lastMessageAt: chatsTable.lastMessageAt,
};

export async function drillList(
  metric: string,
  allowed: Set<number>,
  range: DashboardRange,
  agentUserId: number
): Promise<DrillRow[]> {
  if (noChannels(allowed)) return [];
  const ids = [...allowed];
  const inChan = inArray(chatsTable.channelId, ids);
  const createdInRange = and(
    gte(chatsTable.createdAt, range.from),
    lte(chatsTable.createdAt, range.to)
  );

  let where;
  switch (metric) {
    case "waiting":
      where = and(inChan, eq(chatsTable.isArchived, false), sql`${lastDirection} = 'inbound'`);
      break;
    case "my_active":
      where = and(inChan, eq(chatsTable.assignedUserId, agentUserId), eq(chatsTable.isArchived, false));
      break;
    case "lead":
      where = and(inChan, createdInRange, eq(chatsTable.leadStatus, "lead"));
      break;
    case "not_lead":
      where = and(inChan, createdInRange, eq(chatsTable.leadStatus, "not_lead"));
      break;
    case "unknown":
      where = and(inChan, createdInRange, eq(chatsTable.leadStatus, "unknown"));
      break;
    case "conversations":
    default:
      where = and(inChan, createdInRange);
      break;
  }

  return db
    .select(DRILL_COLS)
    .from(chatsTable)
    .where(where)
    .orderBy(desc(chatsTable.lastMessageAt))
    .limit(500);
}

// ── Menu chatbot ditekan (spec A.4): pressed-option ranking from
// chatbot_flow_events (only nodes with countInDashboard=true write rows).
export interface FlowMenuRow {
  label: string;
  level: number;
  count: number;
}

export async function flowMenuRanking(
  allowed: Set<number>,
  range: DashboardRange
): Promise<FlowMenuRow[]> {
  if (noChannels(allowed)) return [];
  const rows = await db
    .select({
      label: chatbotFlowEventsTable.nodeLabel,
      level: chatbotFlowEventsTable.level,
      count: sql<number>`count(*)::int`,
    })
    .from(chatbotFlowEventsTable)
    .where(
      and(
        inArray(chatbotFlowEventsTable.channelId, [...allowed]),
        gte(chatbotFlowEventsTable.createdAt, range.from),
        lte(chatbotFlowEventsTable.createdAt, range.to)
      )
    )
    .groupBy(chatbotFlowEventsTable.nodeLabel, chatbotFlowEventsTable.level)
    .orderBy(desc(sql`count(*)`))
    .limit(50);
  return rows.map((r) => ({ label: r.label, level: r.level, count: r.count }));
}

// ── Won (spec A.2, owner-only money KPI): opportunities currently marked won
// whose last activity falls in range. count + summed estimated value (Rupiah).
export async function wonMetric(
  allowed: Set<number>,
  range: DashboardRange
): Promise<{ count: number; value: number }> {
  if (noChannels(allowed)) return { count: 0, value: 0 };
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${opportunitiesTable.estimatedValueIdr}), 0)::bigint`,
    })
    .from(opportunitiesTable)
    .where(
      and(
        inArray(opportunitiesTable.channelId, [...allowed]),
        eq(opportunitiesTable.status, "won"),
        gte(opportunitiesTable.lastActivityAt, range.from),
        lte(opportunitiesTable.lastActivityAt, range.to)
      )
    );
  return { count: row?.count ?? 0, value: Number(row?.value ?? 0) };
}

// ── Produk paling diminati (spec A.3): group analyses by product_interest.
export interface ProductRow {
  product: string;
  count: number;
}

export async function productRanking(
  allowed: Set<number>,
  range: DashboardRange
): Promise<ProductRow[]> {
  if (noChannels(allowed)) return [];
  const rows = await db
    .select({
      product: aiPipelineAnalysesTable.productInterest,
      count: sql<number>`count(*)::int`,
    })
    .from(aiPipelineAnalysesTable)
    .where(
      and(
        inArray(aiPipelineAnalysesTable.channelId, [...allowed]),
        sql`${aiPipelineAnalysesTable.productInterest} is not null and ${aiPipelineAnalysesTable.productInterest} <> ''`,
        gte(aiPipelineAnalysesTable.createdAt, range.from),
        lte(aiPipelineAnalysesTable.createdAt, range.to)
      )
    )
    .groupBy(aiPipelineAnalysesTable.productInterest)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
  return rows.map((r) => ({ product: r.product ?? "", count: r.count }));
}

// ── Chat Tier 2 (spec A.10): inbound volume per hour-of-day over the range.
export async function chatVolumeByHour(
  allowed: Set<number>,
  range: DashboardRange
): Promise<{ hour: number; count: number }[]> {
  const empty = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  if (noChannels(allowed)) return empty;
  const rows = await db
    .select({
      hour: sql<number>`extract(hour from ${chatMessagesTable.createdAt})::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        eq(chatMessagesTable.direction, "inbound"),
        gte(chatMessagesTable.createdAt, range.from),
        lte(chatMessagesTable.createdAt, range.to)
      )
    )
    .groupBy(sql`extract(hour from ${chatMessagesTable.createdAt})`);
  const map = new Map(rows.map((r) => [r.hour, r.count]));
  return empty.map((e) => ({ hour: e.hour, count: map.get(e.hour) ?? 0 }));
}

// ── Chat Tier 2 (spec A.10): outbound reply split AI vs human, over the range.
export async function aiVsHumanCounts(
  allowed: Set<number>,
  range: DashboardRange
): Promise<{ ai: number; human: number }> {
  if (noChannels(allowed)) return { ai: 0, human: 0 };
  const [row] = await db
    .select({
      ai: sql<number>`count(*) filter (where ${chatMessagesTable.isAiGenerated} = true)::int`,
      human: sql<number>`count(*) filter (where ${chatMessagesTable.isAiGenerated} = false)::int`,
    })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, [...allowed]),
        eq(chatMessagesTable.direction, "outbound"),
        gte(chatMessagesTable.createdAt, range.from),
        lte(chatMessagesTable.createdAt, range.to)
      )
    );
  return { ai: row?.ai ?? 0, human: row?.human ?? 0 };
}

// Whether the owner has at least one active chatbot flow — drives the
// conditional "Menu chatbot ditekan" panel (spec 5.1).
export async function ownerHasActiveFlow(ownerUserId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: chatbotFlowsTable.id })
    .from(chatbotFlowsTable)
    .where(
      and(
        eq(chatbotFlowsTable.userId, ownerUserId),
        eq(chatbotFlowsTable.isActive, true)
      )
    )
    .limit(1);
  return !!row;
}
