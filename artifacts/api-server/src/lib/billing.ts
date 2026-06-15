import { db } from "@workspace/db";
import {
  pricingConfigTable,
  subscriptionsTable,
  usageSnapshotsTable,
  usersTable,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  aiUsageEventsTable,
  mediaObjectsTable,
  invoicesTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  mrrFromInvoices,
  dailyRevenueTrendFromInvoices,
  type RevenueTrendPoint,
} from "./revenue-build";
import {
  computeMonthlyBill,
  computeEffectiveStatus,
  isReadOnlySubscription,
  addMonths,
  type BillBreakdown,
  type BillingPricing,
  type BillingUsage,
  type StoredSubscriptionStatus,
} from "./billing-engine";
import { computeBillingPeriod } from "./billing-period";
import { isInfinityOwner } from "./infinity-owner";
import { logger } from "./logger";

// New tenants get a 7-day trial; after that they fall into read-only until an
// admin marks them paid.
const TRIAL_DAYS = 7;

const PRICING_ROW_ID = 1;

// ----- Pricing config (admin-configurable, singleton row id=1) -----

export async function getPricing(): Promise<BillingPricing> {
  const [row] = await db
    .select()
    .from(pricingConfigTable)
    .where(eq(pricingConfigTable.id, PRICING_ROW_ID))
    .limit(1);
  if (row) {
    return {
      dbPricePer500Mb: row.dbPricePer500Mb,
      userPricePerUser: row.userPricePerUser,
      channelPricePer2: row.channelPricePer2,
    };
  }
  // Self-heal: seed the singleton with column defaults if it's somehow missing.
  const [seeded] = await db
    .insert(pricingConfigTable)
    .values({ id: PRICING_ROW_ID })
    .onConflictDoNothing()
    .returning();
  const r = seeded ?? {
    dbPricePer500Mb: 50000,
    userPricePerUser: 50000,
    channelPricePer2: 50000,
  };
  return {
    dbPricePer500Mb: r.dbPricePer500Mb,
    userPricePerUser: r.userPricePerUser,
    channelPricePer2: r.channelPricePer2,
  };
}

export async function updatePricing(
  values: BillingPricing,
  updatedBy: number | null
): Promise<BillingPricing> {
  // Ensure the singleton exists, then write the new prices.
  await db
    .insert(pricingConfigTable)
    .values({ id: PRICING_ROW_ID, ...values, updatedBy })
    .onConflictDoUpdate({
      target: pricingConfigTable.id,
      set: { ...values, updatedBy, updatedAt: new Date() },
    });
  return getPricing();
}

// ----- Subscription (one row per owner, created lazily) -----

export interface SubscriptionInfo {
  status: string;
  currentPeriodEnd: string | null;
  createdAt: string;
}

export async function getOrCreateSubscription(
  ownerId: number
): Promise<SubscriptionInfo> {
  const [existing] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, ownerId))
    .limit(1);
  if (existing) {
    return {
      status: existing.status,
      currentPeriodEnd: existing.currentPeriodEnd?.toISOString() ?? null,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  // Lazily create for pre-existing owners: default to active, period end at
  // the next join-anchored billing boundary.
  const [owner] = await db
    .select({ createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const joinDate = owner?.createdAt ?? new Date();
  const { end } = computeBillingPeriod(joinDate, new Date());

  const [created] = await db
    .insert(subscriptionsTable)
    .values({ userId: ownerId, status: "active", currentPeriodEnd: end })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return {
      status: created.status,
      currentPeriodEnd: created.currentPeriodEnd?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
    };
  }
  // Lost a race — read the row the other writer just inserted.
  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, ownerId))
    .limit(1);
  return {
    status: row?.status ?? "active",
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? end.toISOString(),
    createdAt: row?.createdAt.toISOString() ?? new Date().toISOString(),
  };
}

// Resolved view of a subscription: the STORED status plus the EFFECTIVE status
// (which collapses an overdue trial/active into "expired") and the read-only
// flag the access layer enforces.
export interface EffectiveSubscription extends SubscriptionInfo {
  effectiveStatus: StoredSubscriptionStatus;
  readOnly: boolean;
}

export async function getEffectiveSubscription(
  ownerId: number
): Promise<EffectiveSubscription> {
  const info = await getOrCreateSubscription(ownerId);
  // Owner Infinity accounts are never read-only and never expire: force an
  // "active" effective status regardless of the stored period. This is the
  // single derivation isOwnerReadOnly (and thus enforce-subscription, the AI
  // auto-reply gate, and billing/me) all read from, so the bypass lands
  // everywhere from one place.
  if (await isInfinityOwner(ownerId)) {
    return { ...info, effectiveStatus: "active", readOnly: false };
  }
  const effectiveStatus = computeEffectiveStatus(
    info.status,
    info.currentPeriodEnd,
    new Date()
  );
  return {
    ...info,
    effectiveStatus,
    readOnly: isReadOnlySubscription(effectiveStatus),
  };
}

// Cheap boolean for hot paths (enforcement middleware, bot auto-reply gate).
export async function isOwnerReadOnly(ownerId: number): Promise<boolean> {
  const { readOnly } = await getEffectiveSubscription(ownerId);
  return readOnly;
}

// Create the initial 7-day trial for a brand-new owner. Idempotent: if a row
// already exists (e.g. re-signup race) it is left untouched.
export async function createTrialSubscription(ownerId: number): Promise<void> {
  const end = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await db
    .insert(subscriptionsTable)
    .values({ userId: ownerId, status: "trial", currentPeriodEnd: end })
    .onConflictDoNothing();
}

export interface RenewOptions {
  // Set the stored status outright (e.g. "active" to mark paid, "suspended"
  // to manually freeze, "trial"/"expired" for corrections).
  status?: StoredSubscriptionStatus;
  // Push the current period end forward by this many whole months from
  // max(now, currentPeriodEnd). Omit/0 to leave the period untouched.
  extendMonths?: number;
  // Grant infinite validity: force status "active" and clear currentPeriodEnd
  // (a null period end means "never expires" — computeEffectiveStatus keeps it
  // active forever). Takes precedence over status/extendMonths.
  setUnlimited?: boolean;
}

// Admin action: change status and/or extend the paid period. Marking a tenant
// paid is `{ status: "active", extendMonths: 1 }` — which both unblocks them and
// moves the period end a month ahead of now.
export async function renewSubscription(
  ownerId: number,
  opts: RenewOptions
): Promise<EffectiveSubscription> {
  // Ensure a row exists first so the update always hits something.
  await getOrCreateSubscription(ownerId);
  const [current] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, ownerId))
    .limit(1);

  const set: Partial<typeof subscriptionsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (opts.setUnlimited) {
    // Infinite validity wins over status/extendMonths: active + no expiry.
    set.status = "active";
    set.currentPeriodEnd = null;
  } else {
    if (opts.status) set.status = opts.status;
    if (opts.extendMonths && opts.extendMonths > 0) {
      const now = new Date();
      const base =
        current?.currentPeriodEnd &&
        current.currentPeriodEnd.getTime() > now.getTime()
          ? current.currentPeriodEnd
          : now;
      set.currentPeriodEnd = addMonths(base, opts.extendMonths);
    }
  }

  await db
    .update(subscriptionsTable)
    .set(set)
    .where(eq(subscriptionsTable.userId, ownerId));

  return getEffectiveSubscription(ownerId);
}

// Reporting hygiene: flip overdue trial/active rows to "expired" in the DB so
// admin lists and revenue aggregates read a consistent status. Enforcement does
// not depend on this (it computes effective status live), but the daily flip
// keeps the stored value from drifting. Returns the number of rows updated.
export async function transitionExpiredSubscriptions(): Promise<number> {
  const now = new Date();
  const result = await db
    .update(subscriptionsTable)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(subscriptionsTable.status, ["trial", "active"]),
        sql`${subscriptionsTable.currentPeriodEnd} is not null`,
        lt(subscriptionsTable.currentPeriodEnd, now)
      )
    )
    .returning({ id: subscriptionsTable.id });
  return result.length;
}

// ----- Live usage for an owner -----

export interface OwnerUsage extends BillingUsage {
  // Legacy metered metric: pg_column_size of the owner's chats + messages.
  // Drives the old per-500MB DB charge and the usage snapshots; kept as-is so
  // metered billing stays stable.
  storageBytes: number;
  // Object Storage footprint = SUM(media_objects.size_bytes) for this owner.
  // This is the canonical "penyimpanan terpakai" measured against the tenant's
  // storage_limit (plan base + storage add-ons). Source of truth for the
  // storage quota + monitoring (FASE B/C) and retention/reset (FASE D/E).
  mediaStorageBytes: number;
  childUserCount: number;
  channelCount: number;
  tokenUsage: number;
}

export async function computeOwnerUsage(ownerId: number): Promise<OwnerUsage> {
  // Child users (supervisor/agent) — the owner doesn't count.
  const [teamAgg] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(usersTable)
    .where(eq(usersTable.parentUserId, ownerId));
  const childUserCount = teamAgg?.n ?? 0;

  // Channels owned by this tenant.
  const channels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerId));
  const channelIds = channels.map((c) => c.id);
  const channelCount = channelIds.length;

  // Chat-storage footprint (pg_column_size of chats + their messages).
  let storageBytes = 0;
  if (channelIds.length > 0) {
    const [chatAgg] = await db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${chatsTable})), 0)::bigint`,
      })
      .from(chatsTable)
      .where(inArray(chatsTable.channelId, channelIds));
    const [msgAgg] = await db
      .select({
        bytes: sql<string>`coalesce(sum(pg_column_size(${chatMessagesTable})), 0)::bigint`,
      })
      .from(chatMessagesTable)
      .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
      .where(inArray(chatsTable.channelId, channelIds));
    storageBytes = Number(chatAgg?.bytes ?? 0) + Number(msgAgg?.bytes ?? 0);
  }

  // Object Storage footprint: SUM of every media_objects row for this owner.
  // Owner-keyed (not channel-keyed) so it survives channel deletes and counts
  // owner-level assets (product images, generated docs) too.
  const [mediaAgg] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${mediaObjectsTable.sizeBytes}), 0)::bigint`,
    })
    .from(mediaObjectsTable)
    .where(eq(mediaObjectsTable.ownerUserId, ownerId));
  const mediaStorageBytes = Number(mediaAgg?.bytes ?? 0);

  // AI tokens consumed in the owner's CURRENT billing period (join-anchored).
  const [owner] = await db
    .select({ createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  const joinDate = owner?.createdAt ?? new Date();
  const { start, end } = computeBillingPeriod(joinDate, new Date());
  const [tokenAgg] = await db
    .select({
      total: sql<number>`cast(coalesce(sum(${aiUsageEventsTable.totalTokens}), 0) as int)`,
    })
    .from(aiUsageEventsTable)
    .where(
      and(
        eq(aiUsageEventsTable.userId, ownerId),
        gte(aiUsageEventsTable.createdAt, start),
        lt(aiUsageEventsTable.createdAt, end)
      )
    );
  const tokenUsage = tokenAgg?.total ?? 0;

  return {
    storageBytes,
    mediaStorageBytes,
    childUserCount,
    channelCount,
    tokenUsage,
  };
}

export interface OwnerBill {
  usage: OwnerUsage;
  pricing: BillingPricing;
  breakdown: BillBreakdown;
}

export async function computeOwnerBill(ownerId: number): Promise<OwnerBill> {
  const [usage, pricing] = await Promise.all([
    computeOwnerUsage(ownerId),
    getPricing(),
  ]);
  const breakdown = computeMonthlyBill(usage, pricing);
  return { usage, pricing, breakdown };
}

// ----- Daily usage snapshot (scheduler) -----

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function listOwnerIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`${usersTable.parentUserId} is null`);
  return rows.map((r) => r.id);
}

// Write (or refresh) today's snapshot for one owner.
export async function snapshotOwner(
  ownerId: number,
  snapshotDate = todayUtc()
): Promise<void> {
  const { usage, breakdown } = await computeOwnerBill(ownerId);
  await db
    .insert(usageSnapshotsTable)
    .values({
      userId: ownerId,
      snapshotDate,
      storageBytes: usage.storageBytes,
      userCount: usage.childUserCount,
      channelCount: usage.channelCount,
      tokenUsage: usage.tokenUsage,
      dbCharge: breakdown.dbCharge,
      userCharge: breakdown.userCharge,
      channelCharge: breakdown.channelCharge,
      aiCharge: 0, // AI no longer metered here (kept for historical rows)
      totalCharge: breakdown.total,
    })
    .onConflictDoUpdate({
      target: [usageSnapshotsTable.userId, usageSnapshotsTable.snapshotDate],
      set: {
        storageBytes: usage.storageBytes,
        userCount: usage.childUserCount,
        channelCount: usage.channelCount,
        tokenUsage: usage.tokenUsage,
        dbCharge: breakdown.dbCharge,
        userCharge: breakdown.userCharge,
        channelCharge: breakdown.channelCharge,
        aiCharge: 0,
        totalCharge: breakdown.total,
      },
    });
}

async function snapshotAllOwners(): Promise<void> {
  const snapshotDate = todayUtc();
  const ownerIds = await listOwnerIds();
  for (const ownerId of ownerIds) {
    try {
      await snapshotOwner(ownerId, snapshotDate);
    } catch (err) {
      logger.error({ err, ownerId }, "usage snapshot failed for owner");
    }
  }
  logger.info({ count: ownerIds.length, snapshotDate }, "usage snapshots written");
}

let schedulerStarted = false;
let lastSnapshotDate: string | null = null;

// Daily snapshot. A 1-hour ticker checks the wall clock and runs once per UTC
// day (first tick after the date rolls over). Self-dedups via lastSnapshotDate
// so a restart mid-day re-runs at most once more (the upsert makes it
// idempotent anyway).
export function startUsageSnapshotScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const tick = async (): Promise<void> => {
    const today = todayUtc();
    if (lastSnapshotDate === today) return;
    lastSnapshotDate = today;
    try {
      await snapshotAllOwners();
      // Keep stored statuses consistent with the wall clock for reporting.
      const flipped = await transitionExpiredSubscriptions();
      if (flipped > 0) {
        logger.info({ flipped }, "subscriptions transitioned to expired");
      }
    } catch (err) {
      logger.error({ err }, "usage snapshot scheduler tick failed");
      lastSnapshotDate = null; // allow a retry on the next tick
    }
  };

  // Run shortly after boot to capture today, then hourly.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60 * 60 * 1000);
  }, 30_000);
}

// ----- Revenue analytics (Fase 5; rewired to invoices in Billing v2 FASE H) -----

// Re-exported so existing importers keep resolving the type from billing.ts; the
// canonical definition now lives in the db-free revenue-build module.
export type { RevenueTrendPoint };

export interface RevenueSummary {
  mrr: number; // sum of latest monthly_close invoice total per active owner
  arr: number; // mrr * 12
  arpu: number; // mrr / payingTenants (0 if none)
  totalTenants: number;
  activeTenants: number;
  trialTenants: number;
  expiredTenants: number;
  suspendedTenants: number;
  payingTenants: number; // active only — what MRR is based on
  trend: RevenueTrendPoint[]; // daily invoiced revenue across tenants, oldest-first
}

// Platform-wide revenue, sourced from the immutable `invoices` (Billing v2
// FASE H). MRR is the sum of each EFFECTIVE-active owner's LATEST monthly_close
// invoice total — the recurring obligation per billing period — so financials
// are snapshot-correct (a later catalog price edit never rewrites history).
// Effective status is computed live so a just-lapsed owner drops out of MRR
// immediately. The trend series sums every invoice (one-off + recurring) by the
// day it was issued. Tenant counts still derive from subscription status.
export async function computeRevenue(trendDays = 30): Promise<RevenueSummary> {
  const now = new Date();

  // All owners with their stored subscription (left join; lazily-missing rows
  // count as active per getOrCreateSubscription's default).
  const owners = await db
    .select({
      id: usersTable.id,
      status: subscriptionsTable.status,
      currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
    })
    .from(usersTable)
    .leftJoin(
      subscriptionsTable,
      eq(subscriptionsTable.userId, usersTable.id)
    )
    // Tenant owners only: parent_user_id IS NULL AND not the platform admin
    // (role="admin"). The platform super-admin is parent-null too but is not a
    // paying tenant, so it must not inflate counts/MRR/ARPU.
    .where(
      and(
        isNull(usersTable.parentUserId),
        ne(usersTable.role, "admin")
      )
    );

  let activeTenants = 0;
  let trialTenants = 0;
  let expiredTenants = 0;
  let suspendedTenants = 0;
  const activeOwnerIds: number[] = [];
  for (const o of owners) {
    const eff = computeEffectiveStatus(
      o.status ?? "active",
      o.currentPeriodEnd ? o.currentPeriodEnd.toISOString() : null,
      now
    );
    if (eff === "active") {
      activeTenants++;
      activeOwnerIds.push(o.id);
    } else if (eff === "trial") {
      trialTenants++;
    } else if (eff === "suspended") {
      suspendedTenants++;
    } else {
      expiredTenants++;
    }
  }

  // MRR = sum of each ACTIVE owner's LATEST monthly_close invoice total. Pull
  // every monthly_close invoice for the active owners (newest periods are few
  // per owner) and let the pure aggregator pick the latest per owner.
  let mrr = 0;
  if (activeOwnerIds.length > 0) {
    const mcRows = await db
      .select({
        userId: invoicesTable.userId,
        source: invoicesTable.source,
        totalIdr: invoicesTable.totalIdr,
        issuedAt: invoicesTable.issuedAt,
      })
      .from(invoicesTable)
      .where(
        and(
          inArray(invoicesTable.userId, activeOwnerIds),
          eq(invoicesTable.source, "monthly_close")
        )
      );
    mrr = mrrFromInvoices(mcRows, activeOwnerIds);
  }

  const payingTenants = activeTenants;
  const arpu = payingTenants > 0 ? Math.round(mrr / payingTenants) : 0;

  // Daily invoiced revenue for the trend chart: every tenant owner's invoices
  // (one-off + recurring) summed by the day they were issued. Excludes the
  // platform admin's rows (admins are not tenants and never invoiced).
  const sinceDate = new Date(now.getTime() - trendDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const invoiceRows = await db
    .select({
      issuedAt: invoicesTable.issuedAt,
      totalIdr: invoicesTable.totalIdr,
    })
    .from(invoicesTable)
    .innerJoin(usersTable, eq(usersTable.id, invoicesTable.userId))
    .where(
      and(
        gte(invoicesTable.issuedAt, new Date(`${sinceDate}T00:00:00.000Z`)),
        ne(usersTable.role, "admin")
      )
    );

  const trend = dailyRevenueTrendFromInvoices(invoiceRows, sinceDate);

  return {
    mrr,
    arr: mrr * 12,
    arpu,
    totalTenants: owners.length,
    activeTenants,
    trialTenants,
    expiredTenants,
    suspendedTenants,
    payingTenants,
    trend,
  };
}

// One owner's own daily spend series (for the tenant Langganan trend chart).
export async function computeOwnerTrend(
  ownerId: number,
  trendDays = 30
): Promise<RevenueTrendPoint[]> {
  const now = new Date();
  const sinceDate = new Date(now.getTime() - trendDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({
      date: usageSnapshotsTable.snapshotDate,
      totalCharge: usageSnapshotsTable.totalCharge,
      dbCharge: usageSnapshotsTable.dbCharge,
      userCharge: usageSnapshotsTable.userCharge,
      channelCharge: usageSnapshotsTable.channelCharge,
    })
    .from(usageSnapshotsTable)
    .where(
      and(
        eq(usageSnapshotsTable.userId, ownerId),
        gte(usageSnapshotsTable.snapshotDate, sinceDate)
      )
    )
    .orderBy(usageSnapshotsTable.snapshotDate);
  return rows.map((r) => ({
    date: r.date,
    totalCharge: r.totalCharge,
    dbCharge: r.dbCharge,
    userCharge: r.userCharge,
    channelCharge: r.channelCharge,
  }));
}
