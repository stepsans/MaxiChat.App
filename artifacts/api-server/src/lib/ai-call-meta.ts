// Side-channel for threading the SERVING engine + credit callId from the
// failover wrapper (createFailoverClient) to recordAiUsage, WITHOUT changing
// the ~14 AI call sites. The wrapper attaches this to the completion's `usage`
// object (which call sites already forward to recordAiUsage as `usage:
// response.usage`). A Symbol key keeps it off JSON serialization and out of the
// way of the real OpenAI usage fields.

export interface CreditCallMeta {
  /** The platform engine that actually served the call. */
  engine: string;
  /** Reservation id to settle against (null when the prepaid gate is off). */
  creditCallId: string | null;
}

const CREDIT_META_KEY = Symbol.for("maxichat.creditCallMeta");

export function attachCreditMeta(usage: object | null | undefined, meta: CreditCallMeta): void {
  if (usage && typeof usage === "object") {
    Object.defineProperty(usage, CREDIT_META_KEY, {
      value: meta,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

export function readCreditMeta(usage: unknown): CreditCallMeta | null {
  if (usage && typeof usage === "object" && CREDIT_META_KEY in usage) {
    return (usage as Record<symbol, CreditCallMeta>)[CREDIT_META_KEY] ?? null;
  }
  return null;
}
