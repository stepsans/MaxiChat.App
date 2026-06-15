// Pure, db-free builders for the monthly-close (recurring subscription) invoice
// (Billing v2 — FASE B). Kept free of any @workspace/db runtime import so they
// stay unit-testable under the node:test runner (the db package connects
// eagerly on import). Only TYPE imports are used here — erased at runtime.
import type { InvoiceLineInput } from "./invoice-build";

// The active plan a tenant is currently on, as needed to price the recurring
// charge and derive the standing add-on top-ups (limits above the plan base).
export type MonthlyClosePlan = {
  id: number;
  name: string;
  priceIdr: number;
  quotaTokens: number;
  quotaChannels: number;
  quotaUsers: number;
  quotaStorageBytes: number;
};

// The tenant's current prepaid caps (tenant_quota): plan base + standing
// add-on top-ups bought within the period.
export type MonthlyCloseQuota = {
  tokenLimit: number;
  channelLimit: number;
  userLimit: number;
  storageLimit: number;
};

// A representative active add-on of one type, used to price a standing quota
// top-up. There is no per-tenant "subscribed add-ons" table — the only durable
// signal of standing add-ons is the delta between the tenant's quota and the
// plan base, so we price that delta against the current catalog add-on.
export type AddonPricing = {
  id: number;
  name: string;
  unitAmount: number;
  priceIdr: number;
};

export type AddonPricingByType = {
  token?: AddonPricing;
  channel?: AddonPricing;
  user_seat?: AddonPricing;
  storage?: AddonPricing;
};

// Deterministic invoice number for a tenant's monthly-close invoice: exactly
// ONE per (owner, billing period). The existing UNIQUE index on
// invoices.invoice_number is therefore the period-idempotency guard — a re-run
// computes the SAME number, so the insert is a no-op (onConflictDoNothing).
// The "MC" segment keeps it from ever colliding with the payment-derived
// `INV-<year>-<padded id>` numbering.
export function monthlyCloseInvoiceNumber(
  ownerId: number,
  periodStart: Date
): string {
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, "0");
  return `INV-${year}-MC-${ownerId}-${month}`;
}

// Price a standing quota top-up (limit above the plan base) as one add-on line.
// Returns null when there is no top-up, no catalog add-on to price it against,
// or the numbers can't yield at least one whole block — we never invent a price
// or emit a zero/negative line.
function deltaLine(
  delta: number,
  addon: AddonPricing | undefined
): InvoiceLineInput | null {
  if (delta <= 0 || !addon || addon.unitAmount <= 0 || addon.priceIdr <= 0) {
    return null;
  }
  // Bill only WHOLE blocks (floor, never round): a partial top-up that doesn't
  // fill a complete add-on block is never charged, so we can only ever
  // under-bill a fractional remainder — never over-bill by rounding up.
  const blocks = Math.floor(delta / addon.unitAmount);
  if (blocks < 1) return null;
  return {
    lineType: "addon",
    refId: addon.id,
    description: addon.name,
    quantity: blocks,
    unitPriceIdr: addon.priceIdr,
    amountIdr: blocks * addon.priceIdr,
  };
}

// Build the recurring invoice lines for a tenant's active plan + standing
// add-ons. Line 1 is always the plan at its current catalog price; each quota
// dimension that sits above the plan base adds one add-on line priced via the
// representative catalog add-on for that type.
export function buildMonthlyCloseLines(
  plan: MonthlyClosePlan,
  quota: MonthlyCloseQuota,
  addons: AddonPricingByType
): InvoiceLineInput[] {
  const lines: InvoiceLineInput[] = [
    {
      lineType: "plan",
      refId: plan.id,
      description: plan.name,
      quantity: 1,
      unitPriceIdr: plan.priceIdr,
      amountIdr: plan.priceIdr,
    },
  ];

  // SPEC BAGIAN 1: AI tokens are NOT a recurring monthly_close line — token
  // add-ons are prepaid credit top-ups (their own payment invoice), so they're
  // excluded from the standing-add-on reconstruction to avoid double billing.

  const channelLine = deltaLine(
    quota.channelLimit - plan.quotaChannels,
    addons.channel
  );
  if (channelLine) lines.push(channelLine);

  const seatLine = deltaLine(quota.userLimit - plan.quotaUsers, addons.user_seat);
  if (seatLine) lines.push(seatLine);

  const storageLine = deltaLine(
    quota.storageLimit - plan.quotaStorageBytes,
    addons.storage
  );
  if (storageLine) lines.push(storageLine);

  return lines;
}
