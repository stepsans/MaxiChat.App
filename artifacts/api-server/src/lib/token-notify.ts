import { eq, gt, sql } from "drizzle-orm";
import { db, tenantQuotaTable, tokenNotifyStateTable } from "@workspace/db";
import { logger } from "./logger";
import { getOwnerTokenQuota } from "./ai-quota";
import { sendEmail } from "./email";
import { notifyLevelRank, type NotifyLevel } from "./ai-usage-build";

// Indonesian copy per threshold (spec E1). warn20 is reserved (never emitted),
// but kept here so the map is exhaustive.
const COPY: Record<
  Exclude<NotifyLevel, "ok">,
  { subject: (plan: string) => string; body: (pct: number, remaining: number) => string }
> = {
  warn80: {
    subject: () => "⚠️ Kuota token AI Anda tinggal 20%",
    body: (pct, remaining) =>
      `Pemakaian token AI sudah ${pct}%. Sisa sekitar ${remaining.toLocaleString("id-ID")} token. ` +
      `Pertimbangkan menambah kuota atau membeli booster sebelum habis agar balasan AI tidak berhenti.`,
  },
  warn20: {
    subject: () => "⚠️ Kuota token AI Anda menipis",
    body: (pct, remaining) =>
      `Pemakaian token AI sudah ${pct}%. Sisa sekitar ${remaining.toLocaleString("id-ID")} token.`,
  },
  crit5: {
    subject: () => "🔴 Kritis: kuota token AI tinggal 5%",
    body: (pct, remaining) =>
      `Pemakaian token AI sudah ${pct}%. Sisa hanya ${remaining.toLocaleString("id-ID")} token. ` +
      `Segera beli booster — saat kuota habis, semua fitur AI berhenti otomatis.`,
  },
  depleted: {
    subject: () => "⛔ Kuota token AI habis — fitur AI dihentikan",
    body: () =>
      `Kuota token AI Anda sudah habis. Auto-reply WhatsApp kini memakai pesan fallback statis, ` +
      `dan fitur AI lain berhenti sampai Anda menambah kuota atau membeli booster.`,
  },
};

// Evaluate one owner and email if the threshold level has ESCALATED since the
// last email this period. Best-effort: never throws. Returns the level emailed,
// or null when nothing was sent.
export async function maybeNotifyTokenThreshold(
  ownerUserId: number,
  now: Date = new Date()
): Promise<NotifyLevel | null> {
  try {
    const q = await getOwnerTokenQuota(ownerUserId, now);
    if (!q) return null;
    // Uncapped (infinity / unprovisioned) never warns.
    if (q.tokenLimit <= 0) return null;

    const [state] = await db
      .select()
      .from(tokenNotifyStateTable)
      .where(eq(tokenNotifyStateTable.ownerUserId, ownerUserId))
      .limit(1);

    // A new period resets the escalation ladder.
    const samePeriod =
      state?.periodStart != null &&
      state.periodStart.getTime() === q.periodStart.getTime();
    const lastLevel: NotifyLevel = samePeriod
      ? (state!.lastLevel as NotifyLevel)
      : "ok";

    const escalated =
      q.notifyLevel !== "ok" &&
      notifyLevelRank(q.notifyLevel) > notifyLevelRank(lastLevel);

    // Always keep state current (record the period + level we've observed) so a
    // period rollover resets cleanly even when no email is due.
    await db
      .insert(tokenNotifyStateTable)
      .values({
        ownerUserId,
        lastLevel: escalated ? q.notifyLevel : lastLevel,
        periodStart: q.periodStart,
      })
      .onConflictDoUpdate({
        target: tokenNotifyStateTable.ownerUserId,
        set: {
          lastLevel: escalated ? q.notifyLevel : lastLevel,
          periodStart: q.periodStart,
          updatedAt: now,
        },
      });

    if (!escalated) return null;

    const copy = COPY[q.notifyLevel as Exclude<NotifyLevel, "ok">];
    await sendEmail({
      to: q.email,
      subject: copy.subject(q.planName),
      text:
        copy.body(q.usagePercent, q.tokenRemaining) +
        `\n\nPaket: ${q.planName}. Periode berakhir ${q.periodEnd.toISOString().slice(0, 10)}.` +
        `\n\nBuka dashboard → Pemakaian Token untuk menambah kuota / beli booster.`,
    });
    logger.info(
      { ownerUserId, level: q.notifyLevel, usagePercent: q.usagePercent },
      "token threshold email sent"
    );
    return q.notifyLevel;
  } catch (err) {
    logger.error({ err, ownerUserId }, "maybeNotifyTokenThreshold failed");
    return null;
  }
}

// Sweep all capped owners and fire escalation emails. Driven on a timer so the
// hot AI path stays cheap — the in-app bell reflects notifyLevel live from
// /ai-usage/me, while email is for tenants not currently in the app.
export async function runTokenNotifySweep(now: Date = new Date()): Promise<void> {
  const owners = await db
    .select({ ownerUserId: tenantQuotaTable.userId })
    .from(tenantQuotaTable)
    .where(gt(tenantQuotaTable.tokenLimit, 0))
    .orderBy(sql`${tenantQuotaTable.userId}`)
    .limit(2000);
  for (const o of owners) {
    await maybeNotifyTokenThreshold(o.ownerUserId, now);
  }
}

let notifyTimer: NodeJS.Timeout | null = null;

export function startTokenNotifyScheduler(): void {
  if (notifyTimer) return;
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const run = () => {
    runTokenNotifySweep().catch((err) =>
      logger.error({ err }, "token notify sweep failed")
    );
  };
  setTimeout(run, 8 * 60 * 1000); // 8 min after boot
  notifyTimer = setInterval(run, FIFTEEN_MIN);
}
