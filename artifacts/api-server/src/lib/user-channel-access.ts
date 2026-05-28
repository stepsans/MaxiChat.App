import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  userChannelAccessTable,
  usersTable,
} from "@workspace/db";
import { getCurrentTeamRole } from "./team-permissions";
import { resolveOwnerUserId } from "./seed";

// Returns the set of channel ids this user is allowed to see chats in.
// Super admin always returns every channel owned by their tenant — the
// owner cannot lock themselves out by toggling boxes. All other roles
// return exactly the rows stored in user_channel_access (deny by default
// — an empty set means no chat access at all).
export async function getAllowedChannelIds(
  userId: number
): Promise<Set<number>> {
  const role = await getCurrentTeamRole(userId);
  if (role === "super_admin") {
    const owned = await db
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(eq(channelsTable.userId, userId));
    return new Set(owned.map((r) => r.id));
  }
  const ownerId = await resolveOwnerUserId(userId);
  // Join through channels to drop any stale rows for channels that were
  // deleted but somehow survived the FK cascade (defence in depth) and to
  // ensure we never leak a channel from a different tenant if a row was
  // hand-edited.
  const rows = await db
    .select({ channelId: userChannelAccessTable.channelId })
    .from(userChannelAccessTable)
    .innerJoin(
      channelsTable,
      and(
        eq(channelsTable.id, userChannelAccessTable.channelId),
        eq(channelsTable.userId, ownerId)
      )
    )
    .where(eq(userChannelAccessTable.userId, userId));
  return new Set(rows.map((r) => r.channelId));
}

// Replace the user's allow-list. Validates that every channel id belongs
// to the caller's tenant before writing — passing an unrelated channel id
// is silently dropped rather than 403-ing the whole save so an admin who
// ticks a channel that was just deleted in another tab still gets the
// rest of their changes saved.
//
// Concurrency: same FOR UPDATE lock pattern as saveUserOverrides so two
// simultaneous PUTs for the same user serialise and can't race on the
// unique constraint.
export async function setAllowedChannelIds(
  targetUserId: number,
  ownerUserId: number,
  channelIds: number[]
): Promise<number[]> {
  let stored: number[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM ${usersTable} WHERE ${usersTable.id} = ${targetUserId} FOR UPDATE`
    );
    // Re-validate INSIDE the tx so a channel deleted between the request
    // arriving and the insert running can't FK-fail the whole save. The
    // FOR UPDATE lock above doesn't lock channels — this validation does
    // by reading the current channels rows.
    const validRows =
      channelIds.length === 0
        ? []
        : await tx
            .select({ id: channelsTable.id })
            .from(channelsTable)
            .where(
              and(
                eq(channelsTable.userId, ownerUserId),
                inArray(channelsTable.id, channelIds)
              )
            );
    stored = Array.from(new Set(validRows.map((r) => r.id)));
    await tx
      .delete(userChannelAccessTable)
      .where(eq(userChannelAccessTable.userId, targetUserId));
    if (stored.length === 0) return;
    await tx.insert(userChannelAccessTable).values(
      stored.map((channelId) => ({
        userId: targetUserId,
        channelId,
      }))
    );
  });
  return stored;
}

// Returns the full list of channels owned by `ownerUserId` (used as the
// "all possible options" set in the permission editor + as the fallback
// list for super_admin).
export async function listTenantChannels(
  ownerUserId: number
): Promise<
  Array<{ id: number; label: string; kind: string; status: string }>
> {
  const rows = await db
    .select({
      id: channelsTable.id,
      label: channelsTable.label,
      kind: channelsTable.kind,
      status: channelsTable.status,
    })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId))
    .orderBy(asc(channelsTable.id));
  return rows;
}
