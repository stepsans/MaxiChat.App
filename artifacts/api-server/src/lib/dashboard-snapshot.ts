import { and, desc, eq } from "drizzle-orm";
import {
  db,
  channelsTable,
  dashboardSnapshotsTable,
  type DashboardSnapshotPayload,
  type DashboardSnapshotRow,
} from "@workspace/db";
import {
  conversationCount,
  aiHandledPercent,
  hotLeadCount,
  dissatisfiedCount,
  wonMetric,
  leadStatusCounts,
} from "./dashboard-metrics";
import { startOfWibDay, wibCutoffsForDay } from "./timezone";
import { buildDailyNarrative } from "./dashboard-narrative";
import { runScheduledJob } from "./job-runs";
import { logger } from "./logger";

// Pre-compute the heavy Tier-1 analytic KPIs per owner at the WIB cutoffs (spec
// 3.6) so "Hari ini" loads from a single cached row. The live queue is NOT here.

async function ownerChannelIds(ownerUserId: number): Promise<Set<number>> {
  const rows = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));
  return new Set(rows.map((r) => r.id));
}

export async function getLatestSnapshot(
  ownerUserId: number
): Promise<DashboardSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(dashboardSnapshotsTable)
    .where(eq(dashboardSnapshotsTable.ownerUserId, ownerUserId))
    .orderBy(desc(dashboardSnapshotsTable.snapshotAt), desc(dashboardSnapshotsTable.createdAt))
    .limit(1);
  return row ?? null;
}

// Compute + store one snapshot for an owner, as of `snapshotAt` (a WIB cutoff).
// Window = 00:00 WIB → snapshotAt. The daily narrative is generated once/day and
// carried forward across the day's later cutoffs to save tokens.
export async function computeOwnerSnapshot(
  ownerUserId: number,
  snapshotAt: Date
): Promise<void> {
  const allowed = await ownerChannelIds(ownerUserId);
  const from = startOfWibDay(snapshotAt);
  const range = { from, to: snapshotAt };

  const [percakapan, aiPct, leadPanas, tidakPuas, won, leadStatus] = await Promise.all([
    conversationCount(allowed, range),
    aiHandledPercent(allowed, range),
    hotLeadCount(allowed, range),
    dissatisfiedCount(allowed, range),
    wonMetric(allowed, range),
    leadStatusCounts(allowed, range),
  ]);

  // Narrative: reuse the existing one if today's snapshot already has it.
  const prev = await getLatestSnapshot(ownerUserId);
  const sameDay = prev && startOfWibDay(prev.snapshotAt).getTime() === from.getTime();
  let narrative: DashboardSnapshotPayload["narrative"] =
    sameDay ? prev!.payload?.narrative ?? null : null;
  if (!narrative) {
    const n = await buildDailyNarrative(ownerUserId, {
      percakapan: percakapan.count,
      tidak_puas: tidakPuas,
      lead_panas: leadPanas,
      ai_handled_percent: aiPct,
      won,
    }).catch(() => null);
    narrative = n as DashboardSnapshotPayload["narrative"];
  }

  const payload: DashboardSnapshotPayload = {
    percakapan,
    ai_handled_percent: aiPct,
    lead_panas: leadPanas,
    tidak_puas: tidakPuas,
    won,
    lead_status: leadStatus,
    narrative,
  };

  await db.insert(dashboardSnapshotsTable).values({
    ownerUserId,
    snapshotAt,
    windowFrom: from,
    windowTo: snapshotAt,
    payload,
  });
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// The most-recent WIB cutoff at-or-before `now` (falls back to yesterday's last
// cutoff before 09:00 WIB).
function dueCutoff(now: Date): Date {
  const today = wibCutoffsForDay(now).filter((c) => c.getTime() <= now.getTime());
  if (today.length > 0) return today[today.length - 1]!;
  const yesterday = wibCutoffsForDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return yesterday[yesterday.length - 1]!;
}

let schedulerStarted = false;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const due = dueCutoff(new Date());
    const owners = await db
      .selectDistinct({ ownerUserId: channelsTable.userId })
      .from(channelsTable);
    for (const { ownerUserId } of owners) {
      // Idempotent: skip if this owner already has the due cutoff snapshotted.
      const [existing] = await db
        .select({ id: dashboardSnapshotsTable.id })
        .from(dashboardSnapshotsTable)
        .where(
          and(
            eq(dashboardSnapshotsTable.ownerUserId, ownerUserId),
            eq(dashboardSnapshotsTable.snapshotAt, due)
          )
        )
        .limit(1);
      if (existing) continue;
      try {
        await runScheduledJob("dashboard_snapshot", ownerUserId, () =>
          computeOwnerSnapshot(ownerUserId, due)
        );
      } catch (err) {
        logger.warn({ err, ownerUserId }, "[dashboard-snapshot] owner compute failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "[dashboard-snapshot] tick failed");
  } finally {
    inFlight = false;
  }
}

// Manual recompute for the "Refresh sekarang" button (spec 3.6). Snapshots as of
// NOW (strictly newer than any cutoff row) so getLatestSnapshot returns it.
export async function refreshOwnerSnapshot(ownerUserId: number): Promise<void> {
  await computeOwnerSnapshot(ownerUserId, new Date());
}

export function startDashboardSnapshotScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => void tick(), 60_000); // 1 min after boot
  const timer = setInterval(() => void tick(), 5 * 60_000); // every 5 min
  if (typeof timer.unref === "function") timer.unref();
  logger.info("dashboard-snapshot scheduler started");
}
