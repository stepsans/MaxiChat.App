// Pure, db-free billing math for the usage-based pricing model. Kept free of
// any @workspace/db import so it can be unit-tested directly (the db package
// connects eagerly). All money is whole Indonesian Rupiah.
//
// Pricing model (each component billed in buckets, rounded UP):
//   db      = ceil(storageMb / 500)  * dbPricePer500Mb
//   user    = childUserCount         * userPricePerUser
//   channel = ceil(channelCount / 2) * channelPricePer2
//   ai      = ceil(tokenUsage / 100) * aiPricePer100Tokens
//   total   = sum of the four

export interface BillingPricing {
  dbPricePer500Mb: number;
  userPricePerUser: number;
  channelPricePer2: number;
  aiPricePer100Tokens: number;
}

export interface BillingUsage {
  storageBytes: number;
  childUserCount: number;
  channelCount: number;
  tokenUsage: number;
}

export interface BillBreakdown {
  dbCharge: number;
  userCharge: number;
  channelCharge: number;
  aiCharge: number;
  total: number;
}

const BYTES_PER_MB = 1024 * 1024;

// Whole buckets needed to cover `amount` at `per` units per bucket. Returns 0
// for non-positive usage; never negative. A non-positive bucket size disables
// that component (returns 0) so a misconfigured price can't divide-by-zero.
function buckets(amount: number, per: number): number {
  if (amount <= 0 || per <= 0) return 0;
  return Math.ceil(amount / per);
}

export function computeMonthlyBill(
  usage: BillingUsage,
  pricing: BillingPricing
): BillBreakdown {
  const storageMb = Math.max(0, usage.storageBytes) / BYTES_PER_MB;

  const dbCharge = buckets(storageMb, 500) * Math.max(0, pricing.dbPricePer500Mb);
  const userCharge =
    Math.max(0, Math.floor(usage.childUserCount)) *
    Math.max(0, pricing.userPricePerUser);
  const channelCharge =
    buckets(usage.channelCount, 2) * Math.max(0, pricing.channelPricePer2);
  const aiCharge =
    buckets(usage.tokenUsage, 100) * Math.max(0, pricing.aiPricePer100Tokens);

  const total = dbCharge + userCharge + channelCharge + aiCharge;

  return { dbCharge, userCharge, channelCharge, aiCharge, total };
}
