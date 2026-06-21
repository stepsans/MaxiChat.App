// Pure, db-free logic for splitting an AI token charge across the grant bucket
// and paid boosters (LOCKED spec B3: grant first, then boosters FIFO by soonest
// expiry). Kept out of the db service so node:test can exercise it directly.

export interface BoosterLike {
  id: number;
  remainingTokens: number;
  // ISO string or epoch ms — only used for ordering (soonest first).
  expiresAt: Date;
}

export interface BoosterDecrement {
  id: number;
  decrementBy: number;
  newRemaining: number;
}

// Given the portion of a charge that overflows past the grant, decide how much
// to take from each booster, soonest-expiry first. Returns only the boosters
// actually touched. `unmet` is the overflow that no booster could cover (the
// hard-block in Step 4 prevents ever reaching here, but we surface it for
// logging rather than silently dropping it).
export function planBoosterConsumption(
  overflowTokens: number,
  boosters: BoosterLike[]
): { decrements: BoosterDecrement[]; unmet: number } {
  if (overflowTokens <= 0) return { decrements: [], unmet: 0 };

  const ordered = [...boosters]
    .filter((b) => b.remainingTokens > 0)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());

  let left = overflowTokens;
  const decrements: BoosterDecrement[] = [];
  for (const b of ordered) {
    if (left <= 0) break;
    const take = Math.min(b.remainingTokens, left);
    decrements.push({
      id: b.id,
      decrementBy: take,
      newRemaining: b.remainingTokens - take,
    });
    left -= take;
  }
  return { decrements, unmet: Math.max(0, left) };
}

// How much of a single charge of `chargeTokens` falls on boosters, given the
// period usage BEFORE this charge and the grant limit. Grant absorbs up to its
// remaining headroom; only the spill beyond grant hits boosters. A non-positive
// grantLimit means "no grant bucket" → the whole charge spills to boosters.
export function boosterOverflowForCharge(args: {
  grantLimit: number;
  usageBeforeCharge: number;
  chargeTokens: number;
}): number {
  const { grantLimit, usageBeforeCharge, chargeTokens } = args;
  if (chargeTokens <= 0) return 0;
  const limit = Math.max(0, grantLimit);
  const overflowBefore = Math.max(0, usageBeforeCharge - limit);
  const overflowAfter = Math.max(0, usageBeforeCharge + chargeTokens - limit);
  return overflowAfter - overflowBefore;
}
