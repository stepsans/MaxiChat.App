import {
  db,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  contactLabelsTable,
  customerLabelsTable,
  mediaObjectsTable,
  aiUsageEventsTable,
  usageSnapshotsTable,
  tenantResetAuditTable,
  type TenantResetSummary,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

// Wipe ALL of one tenant's data — chats + messages, contact/label data,
// analytics snapshots, AI usage logs, and every uploaded file (media_objects
// ledger rows plus the Object Storage blobs under `tenants/<owner>/`). Strictly
// owner-scoped: nothing here touches another tenant, the subscription, plan,
// quota, channels, settings, products, or the user account itself — only the
// operational data a tenant would want to clear to "start fresh".
//
// AI "memory": the AI auto-reply context is derived live from chat history (no
// separate memory table), so wiping chats clears it implicitly.
//
// Ordering & atomicity:
//   1. Object Storage is swept FIRST (best-effort). All of a tenant's media
//      lives under the single prefix `tenants/<owner>/`, so one sweep removes
//      every blob (ledgered AND orphaned) and returns an exact count. Doing it
//      before the DB transaction means a DB rollback leaves orphaned *ledger
//      rows* (which a retry/retention run can still find and re-clean) rather
//      than orphaned *blobs* (a silent storage leak). A sweep failure does not
//      abort the reset — retention reconciles leftover blobs later.
//   2. Every DB delete + the audit insert run in ONE transaction, so the DB
//      state and the audit record are all-or-nothing: a tenant is never left
//      half-wiped, and an audit row never lies about a delete that rolled back.
export async function resetTenant(
  ownerId: number,
  performedByUserId: number
): Promise<TenantResetSummary> {
  const channels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerId));
  const channelIds = channels.map((c) => c.id);

  // --- Uploaded files: sweep the whole tenant prefix (best-effort) ----------
  let files = 0;
  try {
    files = await objectStorage.deleteTenantPrefix(ownerId);
  } catch (err) {
    logger.warn({ err, ownerId }, "tenant-reset: prefix sweep failed");
  }

  // --- All DB deletes + the audit insert: one all-or-nothing transaction ----
  const summary = await db.transaction(async (tx) => {
    // Chats + messages (messages cascade on chat_id).
    let chats = 0;
    let messages = 0;
    if (channelIds.length > 0) {
      const [msgCount] = await tx
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(chatMessagesTable)
        .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
        .where(inArray(chatsTable.channelId, channelIds));
      messages = msgCount?.count ?? 0;
      const deletedChats = await tx
        .delete(chatsTable)
        .where(inArray(chatsTable.channelId, channelIds))
        .returning({ id: chatsTable.id });
      chats = deletedChats.length;
    }

    // Contact label assignments + label definitions.
    const deletedContactLabels = await tx
      .delete(contactLabelsTable)
      .where(eq(contactLabelsTable.ownerUserId, ownerId))
      .returning({ labelId: contactLabelsTable.labelId });
    const deletedLabels = await tx
      .delete(customerLabelsTable)
      .where(eq(customerLabelsTable.ownerUserId, ownerId))
      .returning({ id: customerLabelsTable.id });

    // Analytics snapshots.
    const deletedAnalytics = await tx
      .delete(usageSnapshotsTable)
      .where(eq(usageSnapshotsTable.userId, ownerId))
      .returning({ id: usageSnapshotsTable.id });

    // AI usage logs.
    const deletedLogs = await tx
      .delete(aiUsageEventsTable)
      .where(eq(aiUsageEventsTable.userId, ownerId))
      .returning({ id: aiUsageEventsTable.id });

    // Media ledger rows (blobs already swept above).
    const deletedMedia = await tx
      .delete(mediaObjectsTable)
      .where(eq(mediaObjectsTable.ownerUserId, ownerId))
      .returning({ id: mediaObjectsTable.id });

    const s: TenantResetSummary = {
      chats,
      messages,
      contactLabels: deletedContactLabels.length,
      labels: deletedLabels.length,
      analytics: deletedAnalytics.length,
      logs: deletedLogs.length,
      media: deletedMedia.length,
      files,
    };

    await tx.insert(tenantResetAuditTable).values({
      ownerUserId: ownerId,
      performedByUserId,
      summary: s,
    });

    return s;
  });

  logger.info({ ownerId, performedByUserId, ...summary }, "tenant database reset");
  return summary;
}
