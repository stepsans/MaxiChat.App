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
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
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
      aiPricePer100Tokens: row.aiPricePer100Tokens,
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
    aiPricePer100Tokens: 50000,
  };
  return {
    dbPricePer500Mb: r.dbPricePer500Mb,
    userPricePerUser: r.userPricePerUser,
    channelPricePer2: r.channelPricePer2,
    aiPricePer100Tokens: r.aiPricePer100Tokens,
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
  if (opts.status) set.status = opts.status;
  if (opts.extendMonths && opts.extendMonths > 0) {
    const now = new Date();
    const base =
      current?.currentPeriodEnd && current.currentPeriodEnd.getTime() > now.getTime()
        ? current.currentPeriodEnd
        : now;
    set.currentPeriodEnd = addMonths(base, opts.extendMonths);
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
  storageBytes: number;
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

  return { storageBytes, childUserCount, channelCount, tokenUsage };
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
      aiCharge: breakdown.aiCharge,
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
        aiCharge: breakdown.aiCharge,
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

// ----- Revenue analytics (Fase 5) -----

export interface RevenueTrendPoint {
  date: string; // YYYY-MM-DD
  totalCharge: number;
  dbCharge: number;
  userCharge: number;
  channelCharge: number;
  aiCharge: number;
}

export interface RevenueSummary {
  mrr: number; // sum of latest-snapshot total for paying (active) owners
  arr: number; // mrr * 12
  arpu: number; // mrr / payingTenants (0 if none)
  totalTenants: number;
  activeTenants: number;
  trialTenants: number;
  expiredTenants: number;
  suspendedTenants: number;
  payingTenants: number; // active only — what MRR is based on
  trend: RevenueTrendPoint[]; // daily total across all tenants, oldest-first
}

// Platform-wide revenue. MRR is the sum of each owner's LATEST daily snapshot
// total, counting only owners whose EFFECTIVE status is "active" (trial is not
// revenue; expired/suspended pay nothing). Effective status is computed live so
// a just-lapsed owner drops out of MRR immediately. The trend series sums every
// owner's snapshot per day (cheap; snapshots are pre-aggregated).
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

  // MRR = sum of the latest snapshot total per ACTIVE owner.
  let mrr = 0;
  if (activeOwnerIds.length > 0) {
    const latest = await db
      .select({
        userId: usageSnapshotsTable.userId,
        totalCharge: usageSnapshotsTable.totalCharge,
        snapshotDate: usageSnapshotsTable.snapshotDate,
      })
      .from(usageSnapshotsTable)
      .where(inArray(usageSnapshotsTable.userId, activeOwnerIds))
      .orderBy(
        usageSnapshotsTable.userId,
        sql`${usageSnapshotsTable.snapshotDate} desc`
      );
    const seen = new Set<number>();
    for (const row of latest) {
      if (seen.has(row.userId)) continue; // first row per user is the newest
      seen.add(row.userId);
      mrr += row.totalCharge;
    }
  }

  const payingTenants = activeTenants;
  const arpu = payingTenants > 0 ? Math.round(mrr / payingTenants) : 0;

  // Daily total across all tenants for the trend chart.
  const sinceDate = new Date(now.getTime() - trendDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const trendRows = await db
    .select({
      date: usageSnapshotsTable.snapshotDate,
      totalCharge: sql<number>`cast(coalesce(sum(${usageSnapshotsTable.totalCharge}), 0) as bigint)`,
      dbCharge: sql<number>`cast(coalesce(sum(${usageSnapshotsTable.dbCharge}), 0) as bigint)`,
      userCharge: sql<number>`cast(coalesce(sum(${usageSnapshotsTable.userCharge}), 0) as bigint)`,
      channelCharge: sql<number>`cast(coalesce(sum(${usageSnapshotsTable.channelCharge}), 0) as bigint)`,
      aiCharge: sql<number>`cast(coalesce(sum(${usageSnapshotsTable.aiCharge}), 0) as bigint)`,
    })
    .from(usageSnapshotsTable)
    .where(gte(usageSnapshotsTable.snapshotDate, sinceDate))
    .groupBy(usageSnapshotsTable.snapshotDate)
    .orderBy(usageSnapshotsTable.snapshotDate);

  const trend: RevenueTrendPoint[] = trendRows.map((r) => ({
    date: r.date,
    totalCharge: Number(r.totalCharge),
    dbCharge: Number(r.dbCharge),
    userCharge: Number(r.userCharge),
    channelCharge: Number(r.channelCharge),
    aiCharge: Number(r.aiCharge),
  }));

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
      aiCharge: usageSnapshotsTable.aiCharge,
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
    aiCharge: r.aiCharge,
  }));
}
