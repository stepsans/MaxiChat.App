import app from "./app";
import { startProductSyncScheduler } from "./routes/products-sync";
import { startKnowledgeSyncScheduler } from "./routes/knowledge-sync";
import { startShortcutSyncScheduler } from "./routes/shortcuts-sync";
import { startSalesOrderSyncScheduler } from "./routes/sales-orders";
import { startAiReviewScheduler } from "./lib/ai-review";
import { startUsageSnapshotScheduler } from "./lib/billing";
import { startManualPaymentPoller } from "./lib/manual-payment-poller";
import { startRetentionPurger } from "./lib/retention-purge";
import { startDunningScheduler } from "./lib/dunning";
import { backfillInvoicesFromPayments } from "./lib/invoices";
import { startMonthlyCloseScheduler } from "./lib/monthly-close";
import { startFollowUpScheduler } from "./lib/follow-up-engine";
import { startAiPipelineScheduler } from "./lib/ai-pipeline-scheduler";
import { startDripScheduler } from "./lib/drip-engine";
import { logger } from "./lib/logger";
import { initWhatsapp } from "./routes/whatsapp";
import { runSeed } from "./lib/seed";

// Baileys downloads WhatsApp media over undici. When a media server closes the
// socket mid-stream (common during history sync of expired/403 media), undici
// emits an 'error' event on the response Readable *asynchronously*, after our
// try/catch around downloadMediaMessage has already returned. An unhandled
// 'error' event on a stream becomes an uncaughtException and kills the whole
// process — taking the API (and the groups list) down with it. These are
// transient network errors that are safe to log and ignore; anything else is a
// genuine bug and must still crash the process so we don't mask real failures.
function isRecoverableSocketError(err: unknown): boolean {
  const e = err as
    | { name?: string; code?: string; message?: string; cause?: { code?: string } }
    | null;
  if (!e) return false;
  const codes = new Set([
    "UND_ERR_SOCKET",
    "UND_ERR_ABORTED",
    "ECONNRESET",
    "ETIMEDOUT",
  ]);
  // Prefer explicit error codes (on the error or its cause) — these are the
  // reliable, unambiguous fingerprints of a transient transport failure.
  if (e.code && codes.has(e.code)) return true;
  if (e.cause?.code && codes.has(e.cause.code)) return true;
  // undici surfaces a mid-stream socket close as a `TypeError: terminated`
  // whose `cause` carries the real socket code. Require BOTH the TypeError
  // shape AND a recoverable cause code so we don't swallow an unrelated error
  // that merely happens to carry the word "terminated".
  if (
    e.name === "TypeError" &&
    e.message === "terminated" &&
    !!e.cause?.code &&
    codes.has(e.cause.code)
  ) {
    return true;
  }
  return false;
}

process.on("uncaughtException", (err) => {
  if (isRecoverableSocketError(err)) {
    logger.warn({ err }, "Ignored transient socket error (likely media download)");
    return;
  }
  logger.error({ err }, "Fatal: uncaughtException; exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isRecoverableSocketError(reason)) {
    logger.warn({ err: reason }, "Ignored transient socket rejection (likely media download)");
    return;
  }
  // Mirror the uncaughtException contract: a genuinely unhandled rejection
  // leaves the process in an uncertain state, so fail fast rather than mask it.
  logger.error({ err: reason }, "Fatal: unhandledRejection; exiting");
  process.exit(1);
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Run startup seeding (session table, user upserts, legacy auth migration)
// BEFORE binding the port. If the session table doesn't exist yet, any
// request that hits the express-session middleware will fail — so we must
// not accept traffic until seed has finished. Fail-fast on seed errors.
async function main(): Promise<void> {
  try {
    await runSeed();
  } catch (e) {
    logger.error({ err: e }, "Fatal: runSeed() failed; aborting startup");
    process.exit(1);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    // Baileys reconnects happen after the server is up so any per-user
    // pairing UI is immediately reachable.
    initWhatsapp().catch((e) =>
      logger.error({ err: e }, "initWhatsapp failed (non-fatal)")
    );
    // Auto-sync ticker for Google-Sheet → products bindings. Per-config rows
    // with autoSyncEnabled=true are re-pulled at their configured interval.
    startProductSyncScheduler();
    startKnowledgeSyncScheduler();
    startShortcutSyncScheduler();
    startSalesOrderSyncScheduler();
    startAiReviewScheduler();
    startUsageSnapshotScheduler();
    startManualPaymentPoller();
    startRetentionPurger();
    // Billing v2 (FASE F): dunning escalation sweep. Inert until the operator
    // enables dunning, so prepaid tenants are never auto-suspended by default.
    startDunningScheduler();
    // Billing v2 (FASE B): raise recurring monthly_close invoices per active
    // tenant per period (idempotent per (owner, period) via the deterministic
    // invoice number + unique index).
    startMonthlyCloseScheduler();
    // AI Sales Assistant: Auto Follow-Up engine. Sweeps open opportunities
    // waiting on the customer and (only when a tenant enables the toggle)
    // generates + sends paced, sequenced follow-ups (max 3); default OFF =
    // store a recommendation only, never sends.
    startFollowUpScheduler();
    // AI Pipeline: cut-off analysis sweeper (every 1 min) + follow-up sender (every 5 min).
    startAiPipelineScheduler();
    // Trial onboarding: behavior-based drip campaign engine. Evaluates active
    // trial tenants and enqueues/sends nudge emails (no-op when Resend is
    // unconfigured — logs only). Default-safe, additive.
    startDripScheduler();
    // Billing v2 (FASE A): backfill immutable invoices for any already-paid
    // payments that predate the invoices table. Idempotent + best-effort, so it
    // never blocks boot (the NOT EXISTS filter makes it a no-op once caught up).
    backfillInvoicesFromPayments()
      .then((n) => {
        if (n > 0) logger.info({ created: n }, "invoice backfill complete");
      })
      .catch((err) =>
        logger.error({ err }, "invoice backfill failed (non-fatal)")
      );
  });
}

main();
