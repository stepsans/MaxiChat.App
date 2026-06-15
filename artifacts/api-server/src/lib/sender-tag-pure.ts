// Pure (db-free) sender-signature helpers. Kept separate from sender-tag.ts
// so db-free modules — notably acr-build.ts, which is unit-tested without
// @workspace/db (it connects to Postgres eagerly at import) — can import the
// tag constants + classifier without dragging the database in.

// WhatsApp italic syntax uses underscores. We append on the next line so
// the tag is visually separated from the message body. Empty/whitespace-
// only inputs return the tag as a standalone message (used as a caption
// fallback when an agent attaches media with no caption).
export function withTag(text: string | null | undefined, tag: string): string {
  const body = (text ?? "").trimEnd();
  const sig = `_${tag}_`;
  if (!body) return sig;
  return `${body}\n${sig}`;
}

export const CHATBOT_TAG = "Chatbot";
export const AI_TAG = "powered by AI";
export const FOLLOW_UP_TAG = "follow-up otomatis";

// Strip a trailing `\n\n_<anything>_` signature from a stored outbound
// message before feeding it back to the LLM as conversation history.
// Without this, the model sees its own past `_powered by AI_` (and the
// agent/chatbot tags) and is tempted to either roleplay as that agent
// or to emit a signature itself — which `withTag` would then double up.
export function stripTrailingTag(text: string): string {
  return text.replace(/\n*_[^_\n]+_\s*$/u, "").trimEnd();
}

// The signatures appended by the system's automated outbound paths:
// chatbot-flow sends (CHATBOT_TAG), AI auto-replies (AI_TAG), and automated
// follow-ups (FOLLOW_UP_TAG). A human agent's own signature is their *name*
// (resolveAgentTag), which is deliberately NOT in this set — a dashboard
// human send is identified by sentByUserId, and a name-signed reply that
// somehow lost its sentByUserId should still count as human.
//
// Used to tell a genuine human reply typed on the phone (no sentByUserId,
// no signature) apart from an automated send that also lacks a sentByUserId.
// Matches the tag at the very end of the message, optionally followed by
// trailing whitespace. Anchored so a tag quoted mid-message doesn't trip it.
const AUTOMATED_SIGNATURE_RE =
  /_(?:Chatbot|powered by AI|follow-up otomatis)_\s*$/u;

export function hasAutomatedSignature(content: string | null | undefined): boolean {
  return AUTOMATED_SIGNATURE_RE.test(content ?? "");
}
