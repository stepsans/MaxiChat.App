import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, invoicesTable } from "@workspace/db";
import { computeRevenue } from "./billing";

// DB-backed regression test for computeRevenue (Billing v2 — FASE H). The pure
// aggregators in revenue-build.ts are unit-tested separately; this exercises the
// db-backed wiring that the pure tests can't reach:
//   - MRR sums each ACTIVE owner's LATEST monthly_close invoice (one-off
//     `payment` invoices and OLDER monthly_close periods excluded).
//   - effective status is computed live, so an owner whose period has lapsed
//     drops out of MRR even though its stored status is still "active".
//   - the platform admin (role="admin") is excluded from MRR, the trend, and
//     every tenant count.
//   - the trend sums ALL non-admin invoices (payment + monthly_close, including
//     expired owners) by issued day.
//
// computeRevenue is platform-wide (it scans every user), and the dev DB already
// holds real tenants, so absolute figures aren't assertable. We capture a
// baseline, seed a controlled set, and assert DELTAS.
//
// Robustness against the shared DB + parallel test files (node --test runs each
// file in its own process concurrently): only THIS test mutates `invoices` and
// `subscriptions`, so the MRR and trend deltas are EXACT — and because a broken
// admin/expired-owner filter would pull the admin's 777k / the lapsed owner's
// 999k into those sums, the exact deltas are what genuinely prove those
// exclusions. The tenant-COUNT deltas, by contrast, can be inflated by other
// test files that insert tenant-owner users (all of which become effective-active
// since they create no subscription row), so counts are asserted as lower bounds.

const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let ownerActiveAId: number;
let ownerActiveBId: number;
let ownerExpiredId: number;
let adminId: number;

// All seeded invoices share one UTC day (noon-anchored so second-offsets can't
// roll into the next day) that sits inside computeRevenue's default 30-day trend
// window. The trend assertion compares totals for exactly this day key.
const dayKey = new Date().toISOString().slice(0, 10);
const base = new Date(`${dayKey}T12:00:00.000Z`);
const at = (offsetSeconds: number) => new Date(base.getTime() + offsetSeconds * 1000);

let invCounter = 0;
function invNo(): string {
  invCounter += 1;
  return `INV-TEST-${tag}-${invCounter}`;
}

function trendTotalFor(
  summary: Awaited<ReturnType<typeof computeRevenue>>,
  date: string
): number {
  return summary.trend.find((p) => p.date === date)?.totalCharge ?? 0;
}

let baseline: Awaited<ReturnType<typeof computeRevenue>>;

before(async () => {
  // Capture platform-wide metrics BEFORE seeding so we can assert deltas.
  baseline = await computeRevenue();

  const mkOwner = async (
    suffix: string,
    role: "user" | "admin"
  ): Promise<number> => {
    const [u] = await db
      .insert(usersTable)
      .values({
        email: `rev-${suffix}-${tag}@example.test`,
        passwordHash: "x",
        role,
        status: "active",
        teamRole: "super_admin",
      })
      .returning({ id: usersTable.id });
    return u.id;
  };

  ownerActiveAId = await mkOwner("activeA", "user");
  ownerActiveBId = await mkOwner("activeB", "user");
  ownerExpiredId = await mkOwner("expired", "user");
  adminId = await mkOwner("admin", "admin");

  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  await db.insert(subscriptionsTable).values([
    // active: stored active + period in the future → effective active.
    { userId: ownerActiveAId, status: "active", currentPeriodEnd: future },
    { userId: ownerActiveBId, status: "active", currentPeriodEnd: future },
    // expired: stored "active" but the period has LAPSED → effective expired.
    // This proves MRR is paired with live effective status, not the stored one.
    { userId: ownerExpiredId, status: "active", currentPeriodEnd: past },
  ]);

  await db.insert(invoicesTable).values([
    // ownerActiveA: two monthly_close periods (latest wins for MRR) + a one-off
    // payment (never counts toward MRR, but does count in the trend).
    {
      userId: ownerActiveAId,
      invoiceNumber: invNo(),
      source: "monthly_close",
      totalIdr: 100000,
      issuedAt: at(0),
    },
    {
      userId: ownerActiveAId,
      invoiceNumber: invNo(),
      source: "monthly_close",
      totalIdr: 150000,
      issuedAt: at(2), // newest → the MRR contribution for ownerActiveA
    },
    {
      userId: ownerActiveAId,
      invoiceNumber: invNo(),
      source: "payment",
      totalIdr: 50000,
      issuedAt: at(1),
    },
    // ownerActiveB: single monthly_close.
    {
      userId: ownerActiveBId,
      invoiceNumber: invNo(),
      source: "monthly_close",
      totalIdr: 200000,
      issuedAt: at(0),
    },
    // ownerExpired: monthly_close exists but the owner isn't effective-active,
    // so it's excluded from MRR — yet still contributes to the trend.
    {
      userId: ownerExpiredId,
      invoiceNumber: invNo(),
      source: "monthly_close",
      totalIdr: 999000,
      issuedAt: at(0),
    },
    // platform admin: must be excluded from MRR, counts, AND the trend.
    {
      userId: adminId,
      invoiceNumber: invNo(),
      source: "monthly_close",
      totalIdr: 777000,
      issuedAt: at(0),
    },
  ]);
});

after(async () => {
  // Deleting the users cascades their subscriptions + invoices (both FK
  // onDelete: cascade), so this fully cleans up the seeded rows.
  await db
    .delete(usersTable)
    .where(
      inArray(usersTable.id, [
        ownerActiveAId,
        ownerActiveBId,
        ownerExpiredId,
        adminId,
      ])
    );
});

describe("computeRevenue (db-backed)", () => {
  it("derives MRR/ARR/ARPU/counts/trend from invoices, excluding admin + lapsed owners", async () => {
    const after = await computeRevenue();

    // --- tenant counts (lower bounds: parallel test files may add active
    // tenants concurrently, but never remove mine). My 3 owners must show up as
    // +2 active and +1 expired (the lapsed-period owner is bucketed expired via
    // live effective status); the role="admin" user must NOT be counted, which
    // the exact MRR/trend deltas below independently prove. ---------------------
    assert.ok(after.totalTenants - baseline.totalTenants >= 3);
    assert.ok(after.activeTenants - baseline.activeTenants >= 2);
    assert.ok(after.expiredTenants - baseline.expiredTenants >= 1);

    // --- MRR: ownerActiveA latest (150000) + ownerActiveB (200000). The older
    // monthly_close (100000), the one-off payment (50000), the expired owner
    // (999000) and the admin (777000) are all excluded. -----------------------
    assert.equal(after.mrr - baseline.mrr, 350000);

    // --- ARR + ARPU are exact functions of the post-seed totals --------------
    assert.equal(after.arr, after.mrr * 12);
    assert.ok(after.payingTenants > 0);
    assert.equal(after.arpu, Math.round(after.mrr / after.payingTenants));

    // --- trend: sums EVERY non-admin invoice on the seeded day (both
    // monthly_close periods + the payment + the expired owner's invoice), but
    // NOT the admin's. 100000+150000+50000+200000+999000 = 1,499,000. --------
    const trendDelta =
      trendTotalFor(after, dayKey) - trendTotalFor(baseline, dayKey);
    assert.equal(trendDelta, 1499000);
  });
});
