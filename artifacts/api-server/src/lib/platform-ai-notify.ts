import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { sendTransactionalEmail } from "./email";
import { logger } from "./logger";

// ===========================================================================
// Platform-owner notifications for the centralized AI engine (SPEC BAGIAN 11.2).
// Fired from the failover chain: a failover hop, a total outage, or a recovery.
// Delivery is best-effort email to every platform admin (users.role='admin')
// plus a log line — these NEVER throw into the AI path.
//
// Anti-spam is structural, not stateful: an engine that fails is tripped into
// its circuit-breaker window (markUnhealthy) and skipped until it reopens, so a
// failover email can fire at most once per breaker window per engine.
//
// A local label map avoids importing platform-ai-engine (which would create an
// import cycle through ai-provider → ai-failover).
// ===========================================================================

const ENGINE_LABEL: Record<string, string> = {
  deepseek: "DeepSeek",
  gemini: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Claude (Anthropic)",
};

function label(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

/** Every platform operator's email (role='admin'). */
async function getAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  return rows.map((r) => r.email).filter((e): e is string => !!e);
}

/** Send one notice to all platform admins. Best-effort; never throws. */
async function notifyAdmins(subject: string, text: string): Promise<void> {
  try {
    const emails = await getAdminEmails();
    if (emails.length === 0) return;
    await Promise.all(
      emails.map((to) =>
        sendTransactionalEmail({ to, subject, text }).catch((err) => {
          logger.warn({ err, to, subject }, "platform-ai admin email send failed (non-fatal)");
        }),
      ),
    );
  } catch (err) {
    logger.error({ err, subject }, "notifyAdmins failed");
  }
}

/** A failover hop: `engine` failed (likely billing/quota/down) → moving to next. */
export async function notifyOwnerFailover(engine: string, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err ?? "unknown");
  logger.warn({ engine, reason }, "platform AI failover notification");
  await notifyAdmins(
    `Mesin AI ${label(engine)} gagal — dialihkan ke mesin berikutnya`,
    [
      `Mesin AI ${label(engine)} gagal (kemungkinan masalah pembayaran/kuota/penyedia) dan dialihkan otomatis ke mesin prioritas berikutnya.`,
      "",
      `Detail: ${reason}`,
      "",
      "Periksa billing & kunci API mesin ini di Settings → Mesin AI Platform. Mesin akan dicoba lagi otomatis setelah jeda (circuit breaker).",
    ].join("\n"),
  );
}

/** Every enabled engine failed — AI replies are paused (manual chat still works). */
export async function notifyOwnerAllDown(): Promise<void> {
  logger.error("platform AI all-engines-down notification");
  await notifyAdmins(
    "Semua mesin AI gagal — balasan AI dijeda",
    [
      "Seluruh mesin AI platform gagal merespons. Balasan AI otomatis untuk semua tenant dijeda sementara.",
      "",
      "Chat manual tetap berjalan. Segera periksa billing/kunci API keempat mesin di Settings → Mesin AI Platform.",
    ].join("\n"),
  );
}

/** Auto-failback: a previously-unhealthy engine recovered and is primary again. */
export async function notifyOwnerFailback(engine: string): Promise<void> {
  logger.info({ engine }, "platform AI failback notification");
  await notifyAdmins(
    `Mesin AI ${label(engine)} pulih`,
    `Mesin AI ${label(engine)} kembali sehat dan dipakai sesuai prioritasnya.`,
  );
}
