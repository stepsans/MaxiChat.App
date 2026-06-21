import app, { setReady } from "./app";
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
import { startAcrSchedulesPoller } from "./lib/acr-schedules-poller";
import { startDashboardInsightsScheduler } from "./lib/dashboard-insights";
import { startReportSchedulePoller } from "./lib/report-schedule-runner";
import { startCreditHoldSweeper } from "./lib/credit-wallet";
import { startEngineReprobeScheduler } from "./lib/platform-ai-engine";
import { startDripScheduler } from "./lib/drip-engine";
import { startBoosterExpiryScheduler } from "./lib/token-boosters";
import { startDeferredResumeScheduler } from "./lib/ai-deferred-jobs";
import { startTokenNotifyScheduler } from "./lib/token-notify";
import { logger } from "./lib/logger";
import { initWhatsapp } from "./routes/whatsapp";
import { runSeed } from "./lib/seed";
import { seedPlatformSettingsDefaults } from "./lib/seed-platform-settings";

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

// Bind the port immediately so the deployment healthcheck passes within
// seconds. The readiness gate in app.ts returns 503 for all non-healthcheck
// routes until seed completes, so clients know to retry rather than hitting
// broken session/DB state. Seed operations (which establish the first DB
// connection and may take 10-60s on a cold prod DB) run after the port is
// bound — fail-fast on seed errors, non-fatal on platform-settings seed.
async function main(): Promise<void> {
  // Step 1: bind the port so healthchecks pass immediately.
  await new Promise<void>((resolve, reject) => {
    app.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        reject(err);
        return;
      }
      logger.info({ port }, "Server listening");
      resolve();
    });
  }).catch(() => process.exit(1));

  // Step 2: run seed operations (may block for up to ~60s on cold DB).
  try {
    await runSeed();
  } catch (e) {
    logger.error({ err: e }, "Fatal: runSeed() failed; aborting startup");
    process.exit(1);
  }
  try {
    await seedPlatformSettingsDefaults();
  } catch (e) {
    logger.warn({ err: e }, "seedPlatformSettingsDefaults failed (non-fatal — tables may not exist yet)");
  }

  // Step 3: open to traffic — all routes now respond normally.
  setReady();

  // Step 4: start background workers. Baileys reconnects happen after the
  // server is fully ready so any per-user pairing UI is immediately reachable.
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
  // AI Chat Report: multi-schedule recurring-report poller (every 60s). Runs
  // due acr_schedules. Replaces the legacy single-per-tenant acr-scheduler.
  startAcrSchedulesPoller();
  // Dashboard "Pertanyaan tersering": AI intent-clustering of recent inbound
  // messages, every 6h, cached per owner (token-bounded, never real-time).
  startDashboardInsightsScheduler();
  // Laporan & Jadwal: report-schedule poller (every 60s). Sends due scheduled
  // reports via email and logs each attempt. Additive; no-op when no schedules.
  startReportSchedulePoller();
  // Prepaid AI-credit wallet: reclaim reservations whose calls never settled
  // (crash / dropped path) so `reserved` never leaks. Additive; no-op when the
  // wallet gate is off / no holds exist.
  startCreditHoldSweeper();
  // Prepaid AI engine: actively re-probe tripped engines once their breaker
  // window expires and restore them (auto-failback) before a customer message
  // hits them cold. Additive; no-op when the platform engine is inactive.
  startEngineReprobeScheduler();
  // Trial onboarding: behavior-based drip campaign engine. Evaluates active
  // trial tenants and enqueues/sends nudge emails (no-op when Resend is
  // unconfigured — logs only). Default-safe, additive.
  startDripScheduler();
  // Token boosters (LOCKED spec B2): daily sweep flips boosters past their
  // 90-day expiry to "expired" so they stop counting toward the plafon.
  startBoosterExpiryScheduler();
  // Deferred AI jobs (spec C2): every 5 min, release + re-dispatch jobs held by
  // the token hard-block for owners whose quota has returned.
  startDeferredResumeScheduler();
  // Token threshold emails (spec E1): every 15 min, email owners whose quota
  // crossed 80/5/0%. Anti-spam — one email per threshold per period.
  startTokenNotifyScheduler();
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
}

main();
