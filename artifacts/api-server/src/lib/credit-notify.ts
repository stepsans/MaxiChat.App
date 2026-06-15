import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getCreditWalletSummary, getNotifyState, setNotifyThreshold } from "./credit-wallet";
import { crossedThreshold } from "./credit-math";
import { sendTransactionalEmail } from "./email";
import { logger } from "./logger";

// ===========================================================================
// Tenant low-balance notifications (SPEC BAGIAN 11.1). Fired AFTER each credit
// settlement: when the remaining percent crosses a threshold (20% → 5% → 0%)
// downward, notify the owner exactly once per crossing — anti-spam via
// credit_notify_state.last_threshold, which is re-armed to 100 on top-up/grant.
//
// Delivery is best-effort email + log; it NEVER throws into the AI path. The
// in-app banner is computed separately from the wallet summary the billing page
// already fetches, so a missing email provider still surfaces the warning.
// ===========================================================================

const THRESHOLD_COPY: Record<number, { level: string; subject: string }> = {
  20: { level: "menipis", subject: "Kredit AI menipis (≤20%)" },
  5: { level: "kritis", subject: "Kredit AI kritis (≤5%)" },
  0: { level: "habis", subject: "Kredit AI habis — balasan AI dijeda" },
};

/**
 * Check the owner's wallet against the notification thresholds and, if a new
 * downward crossing occurred, persist it and send a best-effort email. Returns
 * the crossed threshold (or null). Safe to call on every settle; cheap and
 * idempotent per crossing.
 */
export async function maybeNotifyLowBalance(
  ownerUserId: number,
  now: Date = new Date(),
): Promise<number | null> {
  try {
    // minStop is irrelevant to the percent crossing, so pass 0.
    const summary = await getCreditWalletSummary(ownerUserId, 0, now);
    const { lastThreshold } = await getNotifyState(ownerUserId, now);
    const crossed = crossedThreshold(lastThreshold, summary.percentRemaining);
    if (crossed === null) return null;

    // Record the crossing first so a delivery failure never re-fires the email.
    await setNotifyThreshold(ownerUserId, crossed, now);

    const copy = THRESHOLD_COPY[crossed] ?? THRESHOLD_COPY[0]!;
    const [owner] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, ownerUserId))
      .limit(1);

    if (owner?.email) {
      const lines = [
        `Halo ${owner.name ?? "Tim"},`,
        "",
        `Saldo Kredit AI Anda ${copy.level} (tersisa ~${summary.percentRemaining}%, ${summary.available} kredit).`,
        crossed === 0
          ? "Balasan AI otomatis dijeda sampai Anda melakukan top-up. Chat manual tetap berjalan."
          : "Lakukan top-up agar balasan AI tidak terhenti.",
        "",
        "Buka halaman Tagihan untuk melakukan top-up.",
      ];
      // Best-effort: a missing/broken email provider must not break the AI path.
      await sendTransactionalEmail({ to: owner.email, subject: copy.subject, text: lines.join("\n") }).catch((err) => {
        logger.warn({ err, ownerUserId, crossed }, "low-balance email send failed (non-fatal)");
      });
    }

    logger.info({ ownerUserId, crossed, percent: summary.percentRemaining }, "tenant low-credit notification fired");
    return crossed;
  } catch (err) {
    logger.error({ err, ownerUserId }, "maybeNotifyLowBalance failed");
    return null;
  }
}
