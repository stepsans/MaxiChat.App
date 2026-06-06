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
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  computeMonthlyBill,
  type BillBreakdown,
  type BillingPricing,
  type BillingUsage,
} from "./billing-engine";
import { computeBillingPeriod } from "./billing-period";
import { logger } from "./logger";

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
