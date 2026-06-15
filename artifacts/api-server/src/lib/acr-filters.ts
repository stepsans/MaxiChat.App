import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  channelsTable,
  customerLabelsTable,
  type AcrFilterSnapshot,
} from "@workspace/db";

// Resolve the analysis filters applied to a job into a human-readable snapshot
// (channel/label display names included) for the history "Filter Aktif" column.
//
// Best-effort: ids that no longer exist (channel/label deleted) are silently
// dropped, and the function never throws — it must never break job creation or
// a scheduled run. Validation/ownership is enforced upstream at creation; here
// we only render names for ids that still resolve under this owner.
export async function buildAcrFilterSnapshot(
  ownerUserId: number,
  f: {
    leadStatuses?: string[] | null;
    channelIds?: number[] | null;
    customerLabelIds?: number[] | null;
    chatStatuses?: string[] | null;
    includeOwner: boolean;
  }
): Promise<AcrFilterSnapshot> {
  let channels: { id: number; label: string }[] = [];
  if (f.channelIds && f.channelIds.length > 0) {
    const rows = await db
      .select({ id: channelsTable.id, label: channelsTable.label })
      .from(channelsTable)
      .where(
        and(eq(channelsTable.userId, ownerUserId), inArray(channelsTable.id, f.channelIds))
      );
    channels = rows.map((r) => ({ id: r.id, label: r.label }));
  }

  let customerLabels: { id: number; name: string }[] = [];
  if (f.customerLabelIds && f.customerLabelIds.length > 0) {
    const rows = await db
      .select({ id: customerLabelsTable.id, name: customerLabelsTable.name })
      .from(customerLabelsTable)
      .where(
        and(
          eq(customerLabelsTable.ownerUserId, ownerUserId),
          inArray(customerLabelsTable.id, f.customerLabelIds)
        )
      );
    customerLabels = rows.map((r) => ({ id: r.id, name: r.name }));
  }

  return {
    leadStatuses: f.leadStatuses ?? [],
    channels,
    customerLabels,
    chatStatuses: f.chatStatuses ?? [],
    includeOwner: f.includeOwner,
  };
}
