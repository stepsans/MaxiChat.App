import { eq } from "drizzle-orm";
import { db, paymentMethodSettingsTable } from "@workspace/db";
import { readAndSettleManualPayments } from "./manual-payment-sheet";
import { logger } from "./logger";

// Manual-payment verification poller (Hybrid subscription). Every 60s it reads
// the operator's verification Google Sheet and activates any order the operator
// has marked LUNAS. No-op unless the active provider is "manual" and the sheet
// is fully configured (the read fn guards this).

let schedulerStarted = false;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const result = await readAndSettleManualPayments();
    // Record the poll instant so the admin UI can show "last checked".
    try {
      await db
        .update(paymentMethodSettingsTable)
        .set({ lastPolledAt: new Date() })
        .where(eq(paymentMethodSettingsTable.id, 1));
    } catch {
      // best-effort
    }
    if (result.settled > 0 || result.errors > 0) {
      logger.info({ ...result }, "manual-payment poller tick");
    }
  } catch (err) {
    logger.error({ err }, "manual-payment poller tick failed");
  } finally {
    inFlight = false;
  }
}

export function startManualPaymentPoller(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // First tick after 60s to let the server fully boot.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60_000);
  }, 60_000);
  logger.info("manual-payment poller started");
}
