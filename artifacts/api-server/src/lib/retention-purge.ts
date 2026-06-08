import {
  db,
  usersTable,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  mediaObjectsTable,
  aiUsageEventsTable,
  usageSnapshotsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getRetentionPolicy, getPlanRetentionCap, clampPolicy } from "./retention";
import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

// Compute an absolute cutoff Date for a given max-age in days. null = unlimited
// (no purge for that data class).
function cutoffFor(days: number | null, now: number): Date | null {
  if (days == null || days <= 0) return null;
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

// Delete media_objects older than the cutoff for one owner: removes the bucket
// files first (best-effort, idempotent) then the ledger rows. Returns count +
// freed bytes. Old chat_messages.media_url references are intentionally left to
// 404 — expiry of media is the whole point of retention.
async function purgeMedia(ownerId: number, cutoff: Date): Promise<number> {
  const stale = await db
    .select({ id: mediaObjectsTable.id, objectPath: mediaObjectsTable.objectPath })
    .from(mediaObjectsTable)
    .where(
      and(
        eq(mediaObjectsTable.ownerUserId, ownerId),
        lt(mediaObjectsTable.createdAt, cutoff)
      )
    );
  if (stale.length === 0) return 0;
  for (const obj of stale) {
    try {
      await objectStorage.deleteObjectEntity(obj.objectPath);
    } catch (err) {
      // Don't let one bad object block the rest; the row stays so a later run
      // retries the file delete.
      logger.warn({ err, objectPath: obj.objectPath }, "retention: object delete failed");
    }
  }
  const ids = stale.map((o) => o.id);
  await db.delete(mediaObjectsTable).where(inArray(mediaObjectsTable.id, ids));
  return stale.length;
}

// Delete chat_messages older than the cutoff across all the owner's channels.
async function purgeChatMessages(ownerId: number, cutoff: Date): Promise<number> {
  const channels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerId));
  const channelIds = channels.map((c) => c.id);
  if (channelIds.length === 0) return 0;
  const chatRows = await db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(inArray(chatsTable.channelId, channelIds));
  const chatIds = chatRows.map((c) => c.id);
  if (chatIds.length === 0) return 0;
  const deleted = await db
    .delete(chatMessagesTable)
    .where(
      and(
        inArray(chatMessagesTable.chatId, chatIds),
        lt(chatMessagesTable.createdAt, cutoff)
      )
    )
    .returning({ id: chatMessagesTable.id });
  return deleted.length;
}

async function purgeLogs(ownerId: number, cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(aiUsageEventsTable)
    .where(
      and(
        eq(aiUsageEventsTable.userId, ownerId),
        lt(aiUsageEventsTable.createdAt, cutoff)
      )
    )
    .returning({ id: aiUsageEventsTable.id });
  return deleted.length;
}

async function purgeAnalytics(ownerId: number, cutoff: Date): Promise<number> {
  // snapshot_date is a date string; compare against the cutoff's YYYY-MM-DD.
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const deleted = await db
    .delete(usageSnapshotsTable)
    .where(
      and(
        eq(usageSnapshotsTable.userId, ownerId),
        sql`${usageSnapshotsTable.snapshotDate} < ${cutoffDate}`
      )
    )
    .returning({ id: usageSnapshotsTable.id });
  return deleted.length;
}

// Purge one owner according to their (plan-clamped) retention policy.
async function purgeOwner(ownerId: number, now: number): Promise<void> {
  const [policy, cap] = await Promise.all([
    getRetentionPolicy(ownerId),
    getPlanRetentionCap(ownerId),
  ]);
  const effective = clampPolicy(policy, cap);

  const chatCut = cutoffFor(effective.chatDays, now);
  const mediaCut = cutoffFor(effective.mediaDays, now);
  const logCut = cutoffFor(effective.logDays, now);
  const analyticsCut = cutoffFor(effective.analyticsDays, now);

  if (!chatCut && !mediaCut && !logCut && !analyticsCut) return;

  const result = {
    messages: chatCut ? await purgeChatMessages(ownerId, chatCut) : 0,
    media: mediaCut ? await purgeMedia(ownerId, mediaCut) : 0,
    logs: logCut ? await purgeLogs(ownerId, logCut) : 0,
    analytics: analyticsCut ? await purgeAnalytics(ownerId, analyticsCut) : 0,
  };
  if (result.messages || result.media || result.logs || result.analytics) {
    logger.info({ ownerId, ...result }, "retention: purged tenant data");
  }
}

// Enumerate every tenant owner (parent_user_id IS NULL AND role != admin) and
// purge each in turn.
export async function runRetentionPurge(): Promise<void> {
  const now = Date.now();
  const owners = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(isNull(usersTable.parentUserId), ne(usersTable.role, "admin")));
  for (const owner of owners) {
    try {
      await purgeOwner(owner.id, now);
    } catch (err) {
      logger.error({ err, ownerId: owner.id }, "retention: owner purge failed");
    }
  }
}

let schedulerStarted = false;
let inFlight = false;
let lastRunDate: string | null = null;

async function tick(): Promise<void> {
  if (inFlight) return;
  // Run at most once per UTC day.
  const today = new Date().toISOString().slice(0, 10);
  if (lastRunDate === today) return;
  inFlight = true;
  try {
    await runRetentionPurge();
    lastRunDate = today;
  } catch (err) {
    logger.error({ err }, "retention: purge run failed");
  } finally {
    inFlight = false;
  }
}

// Start the daily retention purger. Runs ~2 min after boot, then re-checks
// hourly (the per-day guard makes the hourly tick a no-op until the date rolls).
export function startRetentionPurger(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60 * 60 * 1000);
  }, 120_000);
  logger.info("retention purger started");
}
