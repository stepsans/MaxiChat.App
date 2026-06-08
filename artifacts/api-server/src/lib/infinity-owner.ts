import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Display label + synthetic plan key surfaced by the billing/quota endpoints
// for an Owner Infinity account. Not a real `plans` catalog row.
export const INFINITY_PLAN_LABEL = "Owner Infinity";
export const INFINITY_PLAN_KEY = "infinity";

// Short-lived cache: the flag is an operator-set RBAC override that changes
// very rarely, but isInfinityOwner sits on hot paths (every write request via
// enforce-subscription, every inbound message via the AI auto-reply gate). A
// 60s TTL keeps those paths cheap while still letting a toggle take effect
// within a minute without a process restart.
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { value: boolean; expiresAt: number }>();

// The SINGLE source of truth for "is this owner on the Owner Infinity Plan?".
// Pass an already-resolved owner id (use resolveOwnerUserId first for team
// members). Scoped strictly to the individual account row, so granting it to
// one account never affects any other tenant.
export async function isInfinityOwner(ownerId: number): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(ownerId);
  if (cached && cached.expiresAt > now) return cached.value;

  const [row] = await db
    .select({ flag: usersTable.isInfinityOwner })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const value = row?.flag ?? false;
  cache.set(ownerId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
