import app from "./app";
import { startProductSyncScheduler } from "./routes/products-sync";
import { startKnowledgeSyncScheduler } from "./routes/knowledge-sync";
import { startShortcutSyncScheduler } from "./routes/shortcuts-sync";
import { startAiReviewScheduler } from "./lib/ai-review";
import { logger } from "./lib/logger";
import { initWhatsapp } from "./routes/whatsapp";
import { runSeed } from "./lib/seed";

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
    startAiReviewScheduler();
  });
}

main();
