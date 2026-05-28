import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  channelsTable,
  productChannelsTable,
  knowledgeEntryChannelsTable,
  textShortcutChannelsTable,
} from "@workspace/db";

// Join-table helpers for "Assigned to channels" on shared resources
// (products / knowledge / shortcuts). Semantics:
//   - NO rows in the join table for a resource id → resource is GLOBAL for
//     the owning user (available to every channel they own).
//   - ONE OR MORE rows                            → resource is scoped only
//     to the listed channels.
//
// On the wire we surface `channelIds: number[]` on each resource; an empty
// array means "global". Writes accept the same shape: passing `undefined`
// leaves the assignments untouched, passing `[]` makes the resource global,
// passing `[id, ...]` replaces the assignment set.

export type ResourceKind = "product" | "knowledge" | "shortcut";

// Verify every id in `channelIds` belongs to the owning user. Returns the
// de-duplicated, validated list, or `null` if any id is foreign/unknown.
async function verifyOwnedChannels(
  ownerUserId: number,
  channelIds: number[]
): Promise<number[] | null> {
  const unique = Array.from(
    new Set(channelIds.filter((n) => Number.isInteger(n) && n > 0))
  );
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(
      and(
        eq(channelsTable.userId, ownerUserId),
        inArray(channelsTable.id, unique)
      )
    );
  if (rows.length !== unique.length) return null;
  return unique;
}

// Pre-flight ownership check. Use this BEFORE persisting a parent row in PUT
// handlers so a forbidden channelId can be rejected without writing partial
// state. Returns `true` if every id belongs to `ownerUserId` (or input is
// undefined/empty), `"forbidden"` otherwise.
export async function verifyChannelOwnership(
  ownerUserId: number,
  channelIds: number[] | undefined
): Promise<true | "forbidden"> {
  if (channelIds === undefined) return true;
  const verified = await verifyOwnedChannels(ownerUserId, channelIds);
  return verified === null ? "forbidden" : true;
}

// Replace assignments for ONE resource. Pass `undefined` to skip; `[]` clears
// (becomes global). Returns `true` on success, `"forbidden"` if any channel
// id doesn't belong to the user.
export async function replaceChannelAssignments(
  kind: ResourceKind,
  resourceId: number,
  channelIds: number[] | undefined,
  ownerUserId: number
): Promise<true | "forbidden"> {
  if (channelIds === undefined) return true;
  const verified = await verifyOwnedChannels(ownerUserId, channelIds);
  if (verified === null) return "forbidden";
  await db.transaction(async (tx) => {
    switch (kind) {
      case "product": {
        await tx
          .delete(productChannelsTable)
          .where(eq(productChannelsTable.productId, resourceId));
        if (verified.length > 0) {
          await tx
            .insert(productChannelsTable)
            .values(verified.map((cid) => ({ productId: resourceId, channelId: cid })));
        }
        break;
      }
      case "knowledge": {
        await tx
          .delete(knowledgeEntryChannelsTable)
          .where(eq(knowledgeEntryChannelsTable.knowledgeId, resourceId));
        if (verified.length > 0) {
          await tx
            .insert(knowledgeEntryChannelsTable)
            .values(verified.map((cid) => ({ knowledgeId: resourceId, channelId: cid })));
        }
        break;
      }
      case "shortcut": {
        await tx
          .delete(textShortcutChannelsTable)
          .where(eq(textShortcutChannelsTable.shortcutId, resourceId));
        if (verified.length > 0) {
          await tx
            .insert(textShortcutChannelsTable)
            .values(verified.map((cid) => ({ shortcutId: resourceId, channelId: cid })));
        }
        break;
      }
    }
  });
  return true;
}

// Batch-load channelIds for many resource ids. Returns a Map keyed by
// resource id; ids with no joins map to an empty array (= global).
export async function loadChannelIdsBatch(
  kind: ResourceKind,
  resourceIds: number[]
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  for (const id of resourceIds) out.set(id, []);
  if (resourceIds.length === 0) return out;
  let rows: { rid: number; cid: number }[];
  switch (kind) {
    case "product":
      rows = await db
        .select({
          rid: productChannelsTable.productId,
          cid: productChannelsTable.channelId,
        })
        .from(productChannelsTable)
        .where(inArray(productChannelsTable.productId, resourceIds));
      break;
    case "knowledge":
      rows = await db
        .select({
          rid: knowledgeEntryChannelsTable.knowledgeId,
          cid: knowledgeEntryChannelsTable.channelId,
        })
        .from(knowledgeEntryChannelsTable)
        .where(inArray(knowledgeEntryChannelsTable.knowledgeId, resourceIds));
      break;
    case "shortcut":
      rows = await db
        .select({
          rid: textShortcutChannelsTable.shortcutId,
          cid: textShortcutChannelsTable.channelId,
        })
        .from(textShortcutChannelsTable)
        .where(inArray(textShortcutChannelsTable.shortcutId, resourceIds));
      break;
  }
  for (const r of rows) {
    const arr = out.get(r.rid);
    if (arr) arr.push(r.cid);
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

// Parse a raw request-body `channelIds` field. Returns:
//   - undefined  → field omitted, caller should leave assignments untouched
//   - number[]   → validated shape (positive integers, deduped); [] = global
//   - "invalid"  → field present but malformed (caller should 400)
export function parseChannelIdsInput(
  raw: unknown
): number[] | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return "invalid";
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) return "invalid";
    out.push(n);
  }
  return out;
}
