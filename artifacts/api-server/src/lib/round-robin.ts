import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// Agents whose lastSeenAt is within this window are considered online for
// round-robin purposes. The frontend heartbeats every ~30s while the tab is
// focused, so a 2-minute window comfortably handles brief network blips
// while still excluding agents who have actually closed the dashboard.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

// Pick the next online agent for round-robin assignment under a given owner.
// Returns the chosen agent's users.id, or null if no online agent is
// available (in which case the caller should leave the chat unassigned so a
// supervisor can step in).
//
// Strategy: select all active "agent"-role members under this owner whose
// lastSeenAt is within the online window, ordered by id. Pick the first id
// strictly greater than the stored cursor; if none, wrap to the smallest id.
// Persist the chosen id as the new cursor in the same transaction so two
// concurrent inbound chats don't both land on the same agent.
export async function pickNextRoundRobinAgent(
  ownerId: number
): Promise<number | null> {
  return await db.transaction(async (tx) => {
    // Lock the owner row so concurrent picks serialise on the cursor.
    const [owner] = await tx
      .select({
        cursor: usersTable.roundRobinCursor,
        mode: usersTable.assignmentMode,
      })
      .from(usersTable)
      .where(eq(usersTable.id, ownerId))
      .for("update")
      .limit(1);
    if (!owner || owner.mode !== "round_robin") return null;

    const since = new Date(Date.now() - ONLINE_WINDOW_MS);
    const onlineAgents = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.parentUserId, ownerId),
          eq(usersTable.teamRole, "agent"),
          eq(usersTable.status, "active"),
          gt(usersTable.lastSeenAt, since)
        )!
      )
      .orderBy(asc(usersTable.id));
    if (onlineAgents.length === 0) return null;

    const cursor = owner.cursor ?? 0;
    const next =
      onlineAgents.find((a) => a.id > cursor)?.id ?? onlineAgents[0]!.id;

    await tx
      .update(usersTable)
      .set({ roundRobinCursor: next })
      .where(eq(usersTable.id, ownerId));

    return next;
  });
}

// Look up the owner's assignment mode without touching the cursor — used by
// callers that only need to know whether to invoke round-robin at all.
export async function getAssignmentMode(
  ownerId: number
): Promise<"manual" | "round_robin"> {
  const [row] = await db
    .select({ mode: usersTable.assignmentMode })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  return row?.mode === "round_robin" ? "round_robin" : "manual";
}

// Touch the heartbeat — called by the frontend every ~30s.
export async function touchHeartbeat(userId: number): Promise<void> {
  await db
    .update(usersTable)
    .set({ lastSeenAt: sql`NOW()` })
    .where(eq(usersTable.id, userId));
}
