// ===========================================================================
// AI Sales Assistant — Auto Follow-Up decision (db-free, unit-tested).
//
// Given an opportunity's lifecycle state, how many follow-ups it has already
// received, the relevant stop-signals, and the timing anchors, decide whether
// the NEXT follow-up touch is due (and which sequence number it is), or why it
// is not. Pure state machine → every no-send rule + the max-3 cap are tested
// without the DB. The engine (DB layer) gathers the inputs and acts on the
// decision; it never re-encodes these rules.
//
// Spacing: each touch is `intervalHours` after the LATER of the last meaningful
// interaction and the last follow-up we sent. Anchoring on the last touch (not
// just the meaningful interaction) is what spaces touch-2 after touch-1 instead
// of firing them back-to-back, since our own follow-up is excluded from the
// "meaningful interaction" anchor.
// ===========================================================================

// At most three follow-up touches per opportunity, then the engine STOPS.
export const MAX_FOLLOW_UPS = 3;

export type FollowUpDecisionInput = {
  // Coarse lifecycle: only "open" deals are followed up.
  status: string;
  // Who the deal is waiting on. Follow-ups only fire on "waiting_customer".
  waitingStatus: string | null;
  // Count of follow-ups already sent (0..3). Cancelled/skipped touches don't
  // count toward the cap — only delivered ones.
  sentCount: number;
  // Customer explicitly asked to stop / unsubscribe / not be contacted.
  stopRequested: boolean;
  // The sales rep still has an unfinished task on this deal → defer to a human.
  hasOpenTask: boolean;
  // Timing anchors.
  lastMeaningfulAt: Date | null;
  lastFollowUpAt: Date | null;
  // Tenant's chosen silence window before the next touch.
  intervalHours: number;
  now: Date;
};

export type FollowUpDecisionReason =
  | "terminal_status"
  | "not_waiting_customer"
  | "stop_requested"
  | "open_task"
  | "max_reached"
  | "no_anchor"
  | "not_yet"
  | "due";

export type FollowUpDecision =
  | { due: false; reason: Exclude<FollowUpDecisionReason, "due">; dueAt?: Date }
  | { due: true; reason: "due"; nextSequence: number; dueAt: Date };

const MS_PER_HOUR = 60 * 60 * 1000;

// Decide the next follow-up action for one opportunity. Pure: no I/O, no Date.now
// (caller passes `now`), deterministic.
export function decideFollowUp(input: FollowUpDecisionInput): FollowUpDecision {
  // Hard stops first — none of these should ever send.
  if (input.status !== "open") {
    return { due: false, reason: "terminal_status" };
  }
  if (input.waitingStatus !== "waiting_customer") {
    return { due: false, reason: "not_waiting_customer" };
  }
  if (input.stopRequested) {
    return { due: false, reason: "stop_requested" };
  }
  if (input.hasOpenTask) {
    return { due: false, reason: "open_task" };
  }
  if (input.sentCount >= MAX_FOLLOW_UPS) {
    return { due: false, reason: "max_reached" };
  }
  if (input.lastMeaningfulAt === null) {
    // Nothing substantive to anchor off → never spam blindly.
    return { due: false, reason: "no_anchor" };
  }

  // Anchor = later of (last meaningful interaction, last follow-up sent). A safe
  // interval clamp avoids a zero/negative window scheduling immediately.
  const intervalHours = input.intervalHours > 0 ? input.intervalHours : 48;
  const anchorMs = Math.max(
    input.lastMeaningfulAt.getTime(),
    input.lastFollowUpAt?.getTime() ?? Number.NEGATIVE_INFINITY
  );
  const dueAt = new Date(anchorMs + intervalHours * MS_PER_HOUR);

  if (input.now.getTime() < dueAt.getTime()) {
    return { due: false, reason: "not_yet", dueAt };
  }

  return {
    due: true,
    reason: "due",
    nextSequence: input.sentCount + 1,
    dueAt,
  };
}
