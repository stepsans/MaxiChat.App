// ===========================================================================
// AI Sales Assistant — manual follow-up send guard (pure, db-free).
//
// Decides whether an operator-triggered "send now" on a follow-up touch is
// allowed, based only on the row's current status and the chat's channel kind.
// Kept side-effect-free so the route's preconditions are unit-testable; the
// route still re-asserts the status atomically at the SQL level (claim-first)
// to win any race with the background sweep.
//
//   - Only `pending` touches can be sent (already sent/cancelled/skipped -> 409).
//   - Only WhatsApp channels can send a follow-up; Telegram and other kinds are
//     out of scope for the proactive nudge engine (-> 400).
// ===========================================================================

export type FollowUpStatus = "pending" | "sent" | "cancelled" | "skipped";

export type ManualSendDecision =
  | { ok: true }
  | { ok: false; code: "not_pending" | "not_whatsapp" };

export function decideManualFollowUpSend(input: {
  followUpStatus: FollowUpStatus;
  channelKind: string;
}): ManualSendDecision {
  if (input.followUpStatus !== "pending") {
    return { ok: false, code: "not_pending" };
  }
  if (input.channelKind !== "whatsapp") {
    return { ok: false, code: "not_whatsapp" };
  }
  return { ok: true };
}
