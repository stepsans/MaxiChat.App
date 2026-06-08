import { and, eq, inArray, lt, sql } from "drizzle-orm";
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
import { logger } from "./logger";
import { getRetentionChoice, getRetentionCap } from "./retention-config";
import { retentionCutoffs, type RetentionClass } from "./retention-build";
import { ObjectStorageService } from "./objectStorage";

// Retention purge DB layer (Billing v2 — FASE E). Deletes operational data older
// than the EFFECTIVE per-class retention (min of the tenant's choice and the
// plan cap; computed by the pure retention-build helpers). It NEVER touches
// financial records (invoices, payments, wallet) — those are immutable history.
//
// Safety:
//   - dryRun=true (default) only COUNTS what would be deleted, mutating nothing.
//   - A null cutoff for a class = unlimited → that class is skipped entirely.
//   - Media blobs are removed best-effort BEFORE their ledger rows (blob-first),
//     so a failure leaves a recoverable orphan *ledger row*, not an orphan blob
//     (mirrors tenant-reset's ordering rationale).

const objectStorage = new ObjectStorageService();

export type RetentionPurgeResult = {
  ownerUserId: number;
  dryRun: boolean;
  cutoffs: Record<RetentionClass, string | null>;
  chatMessages: number;
  media: number;
  mediaBlobs: number;
  logs: number;
  analytics: number;
};

export async function purgeTenantRetention(
  ownerUserId: number,
  opts: { dryRun?: boolean; now?: Date } = {}
): Promise<RetentionPurgeResult> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();

  const choice = await getRetentionChoice(ownerUserId);
  const cap = await getRetentionCap(ownerUserId);
  const cutoffs = retentionCutoffs(choice, cap, now);

  const result: RetentionPurgeResult = {
    ownerUserId,
    dryRun,
    cutoffs: {
      chat: cutoffs.chat ? cutoffs.chat.toISOString() : null,
      media: cutoffs.media ? cutoffs.media.toISOString() : null,
      log: cutoffs.log ? cutoffs.log.toISOString() : null,
      analytics: cutoffs.analytics ? cutoffs.analytics.toISOString() : null,
    },
    chatMessages: 0,
    media: 0,
    mediaBlobs: 0,
    logs: 0,
    analytics: 0,
  };

  // --- Chat messages (scoped to the owner's channels) -----------------------
  if (cutoffs.chat) {
    const channels = await db
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(eq(channelsTable.userId, ownerUserId));
    const channelIds = channels.map((c) => c.id);
    if (channelIds.length > 0) {
      const chatIdsRows = await db
        .select({ id: chatsTable.id })
        .from(chatsTable)
        .where(inArray(chatsTable.channelId, channelIds));
      const chatIds = chatIdsRows.map((c) => c.id);
      if (chatIds.length > 0) {
        const [cnt] = await db
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(chatMessagesTable)
          .where(
            and(
              inArray(chatMessagesTable.chatId, chatIds),
              lt(chatMessagesTable.createdAt, cutoffs.chat)
            )
          );
        result.chatMessages = cnt?.count ?? 0;
        if (!dryRun && result.chatMessages > 0) {
          await db
            .delete(chatMessagesTable)
            .where(
              and(
                inArray(chatMessagesTable.chatId, chatIds),
                lt(chatMessagesTable.createdAt, cutoffs.chat)
              )
            );
        }
      }
    }
  }

  // --- Media (ledger rows + blobs, blob-first) ------------------------------
  if (cutoffs.media) {
    const stale = await db
      .select({ id: mediaObjectsTable.id, objectPath: mediaObjectsTable.objectPath })
      .from(mediaObjectsTable)
      .where(
        and(
          eq(mediaObjectsTable.ownerUserId, ownerUserId),
          lt(mediaObjectsTable.createdAt, cutoffs.media)
        )
      );
    result.media = stale.length;
    if (!dryRun && stale.length > 0) {
      for (const row of stale) {
        try {
          await objectStorage.deleteObjectEntity(row.objectPath);
          result.mediaBlobs++;
        } catch (err) {
          logger.warn(
            { err, ownerUserId, objectPath: row.objectPath },
            "retention: blob delete failed (ledger row will still be removed)"
          );
        }
      }
      await db
        .delete(mediaObjectsTable)
        .where(
          inArray(
            mediaObjectsTable.id,
            stale.map((r) => r.id)
          )
        );
    }
  }

  // --- AI usage logs --------------------------------------------------------
  if (cutoffs.log) {
    const [cnt] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(aiUsageEventsTable)
      .where(
        and(
          eq(aiUsageEventsTable.userId, ownerUserId),
          lt(aiUsageEventsTable.createdAt, cutoffs.log)
        )
      );
    result.logs = cnt?.count ?? 0;
    if (!dryRun && result.logs > 0) {
      await db
        .delete(aiUsageEventsTable)
        .where(
          and(
            eq(aiUsageEventsTable.userId, ownerUserId),
            lt(aiUsageEventsTable.createdAt, cutoffs.log)
          )
        );
    }
  }

  // --- Analytics snapshots (snapshotDate is a YYYY-MM-DD text column) --------
  if (cutoffs.analytics) {
    const cutoffDay = cutoffs.analytics.toISOString().slice(0, 10);
    const [cnt] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(usageSnapshotsTable)
      .where(
        and(
          eq(usageSnapshotsTable.userId, ownerUserId),
          lt(usageSnapshotsTable.snapshotDate, cutoffDay)
        )
      );
    result.analytics = cnt?.count ?? 0;
    if (!dryRun && result.analytics > 0) {
      await db
        .delete(usageSnapshotsTable)
        .where(
          and(
            eq(usageSnapshotsTable.userId, ownerUserId),
            lt(usageSnapshotsTable.snapshotDate, cutoffDay)
          )
        );
    }
  }

  return result;
}

// Sweep every tenant owner (real-run). Best-effort per owner; one failure does
// not abort the rest. Returns aggregate counts.
export async function runRetentionSweep(
  now: Date = new Date()
): Promise<{ owners: number; chatMessages: number; media: number; logs: number; analytics: number }> {
  const owners = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`${usersTable.parentUserId} is null and ${usersTable.role} <> 'admin'`);

  const agg = { owners: 0, chatMessages: 0, media: 0, logs: 0, analytics: 0 };
  for (const o of owners) {
    try {
      const r = await purgeTenantRetention(o.id, { dryRun: false, now });
      agg.owners++;
      agg.chatMessages += r.chatMessages;
      agg.media += r.media;
      agg.logs += r.logs;
      agg.analytics += r.analytics;
    } catch (err) {
      logger.error({ err, ownerId: o.id }, "retention sweep failed for owner");
    }
  }
  logger.info(agg, "retention sweep complete");
  return agg;
}

// Daily retention purger. Runs once shortly after boot, then every 24h. The
// per-class cutoffs are null (skip) unless a tenant has chosen a retention age
// AND/OR their plan sets a cap, so this is inert until retention is configured.
let retentionTimer: NodeJS.Timeout | null = null;
export function startRetentionPurger(): void {
  if (retentionTimer) return;
  const DAY = 24 * 60 * 60 * 1000;
  const run = () => {
    runRetentionSweep().catch((err) =>
      logger.error({ err }, "retention purger run failed")
    );
  };
  // First run 5 min after boot to avoid colliding with startup work.
  setTimeout(run, 5 * 60 * 1000);
  retentionTimer = setInterval(run, DAY);
}
