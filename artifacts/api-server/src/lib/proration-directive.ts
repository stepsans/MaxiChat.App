// Pure, db-free encode/decode for the "what to apply on payment" directive
// carried by an OPEN proration invoice (Billing v2 — FASE D). A mid-period plan
// or quota change raises an `open` invoice whose entitlement must be applied
// ONLY after the charge is paid. We stash the directive in `invoices.notes` as
// JSON so no schema change is needed; on settlement the kind="invoice" branch
// decodes it and applies the change. A null/legacy/plain-bill note decodes to
// null → no entitlement change (just paying the bill).

export type InvoiceDirective =
  | { t: "plan"; planId: number }
  | { t: "addon"; addonId: number; quantity: number };

export function encodeInvoiceDirective(d: InvoiceDirective): string {
  return JSON.stringify(d);
}

// Decode a notes string into a directive, or null when it isn't one (plain
// monthly_close bill, free-text note, or malformed JSON). Never throws.
export function decodeInvoiceDirective(
  notes: string | null | undefined
): InvoiceDirective | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.t === "plan" && Number.isInteger(obj.planId)) {
      return { t: "plan", planId: obj.planId as number };
    }
    if (
      obj.t === "addon" &&
      Number.isInteger(obj.addonId) &&
      Number.isInteger(obj.quantity)
    ) {
      return {
        t: "addon",
        addonId: obj.addonId as number,
        quantity: obj.quantity as number,
      };
    }
    return null;
  } catch {
    return null;
  }
}
