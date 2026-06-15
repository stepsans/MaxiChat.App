import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  platformAiEngineTable,
  PLATFORM_AI_ENGINES,
  type PlatformAiEngineRow,
  type PlatformAiEngineName,
} from "@workspace/db";
import { createOpenAiClient } from "@workspace/integrations-openai-ai-server";
import { encryptString, decryptString } from "./crypto";
import { validateBaseUrl } from "./ai-provider";
import { getPlatformAiConfig } from "./platform-ai-config";
import { notifyOwnerFailback } from "./platform-ai-notify";
import { logger } from "./logger";

// ===========================================================================
// The four centralized AI engines (SPEC BAGIAN 4/5). Each is OpenAI-compatible
// so the rest of the stack keeps one client shape (createOpenAiClient). Keys
// are AES-256-GCM at rest, decrypted only in memory, never returned in
// plaintext. callAiWithFailover (ai-failover.ts) iterates these by priority.
// ===========================================================================

export const ENGINE_DEFAULTS: Record<
  PlatformAiEngineName,
  { baseUrl: string; defaultModel: string; label: string }
> = {
  deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", label: "DeepSeek" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
    label: "Google Gemini",
  },
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", label: "OpenAI" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1/", defaultModel: "claude-sonnet-4-6", label: "Claude (Anthropic)" },
};

export class PlatformAiEngineError extends Error {}

function isEngineName(v: string): v is PlatformAiEngineName {
  return (PLATFORM_AI_ENGINES as readonly string[]).includes(v);
}

/** All engine rows, priority-ordered (#1 first). */
export async function getEngines(): Promise<PlatformAiEngineRow[]> {
  return db.select().from(platformAiEngineTable).orderBy(asc(platformAiEngineTable.priority));
}

/**
 * Enabled engines (with a key) ordered by priority — the failover candidate
 * list. Decryption is deferred to buildEngineClient at call time.
 */
export async function getEnabledEnginesByPriority(): Promise<PlatformAiEngineRow[]> {
  const rows = await getEngines();
  return rows.filter((e) => e.isEnabled && e.apiKeyEnc);
}

/** Build a live OpenAI-compatible client for an engine row (SSRF-guarded). */
export function buildEngineClient(row: PlatformAiEngineRow): { client: ReturnType<typeof createOpenAiClient>; model: string } {
  if (!isEngineName(row.engine)) throw new PlatformAiEngineError(`Engine tidak dikenal: ${row.engine}`);
  if (!row.apiKeyEnc) throw new PlatformAiEngineError(`Engine ${row.engine} belum punya kunci.`);
  const defaults = ENGINE_DEFAULTS[row.engine];
  const apiKey = decryptString(row.apiKeyEnc);
  let baseURL = defaults.baseUrl;
  const stored = row.baseUrl?.trim();
  if (stored) {
    const v = validateBaseUrl(stored);
    baseURL = v.ok ? v.url : defaults.baseUrl;
  }
  const client = createOpenAiClient({ apiKey, baseURL });
  const model = row.model?.trim() || defaults.defaultModel;
  return { client, model };
}

// --- health / circuit breaker ----------------------------------------------

export async function markHealthy(engine: string, now: Date = new Date()): Promise<void> {
  await db
    .update(platformAiEngineTable)
    .set({ health: "healthy", unhealthyUntil: null, lastError: null, lastCheckedAt: now, updatedAt: now })
    .where(eq(platformAiEngineTable.engine, engine));
}

export async function markUnhealthy(
  engine: string,
  unhealthyMinutes: number,
  err: unknown,
  now: Date = new Date(),
): Promise<void> {
  const until = new Date(now.getTime() + Math.max(1, unhealthyMinutes) * 60_000);
  const message = err instanceof Error ? err.message : String(err ?? "unknown");
  await db
    .update(platformAiEngineTable)
    .set({
      health: "unhealthy",
      unhealthyUntil: until,
      lastError: message.slice(0, 500),
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(platformAiEngineTable.engine, engine));
}

/** Credit-per-1k-token rate for an engine (for settling its actual charge). */
export async function getEngineCreditRate(engine: string): Promise<number> {
  const [row] = await db
    .select({ rate: platformAiEngineTable.creditPer1kToken })
    .from(platformAiEngineTable)
    .where(eq(platformAiEngineTable.engine, engine))
    .limit(1);
  return row?.rate ?? 1000;
}

// --- owner config ----------------------------------------------------------

function maskKey(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}

export interface PlatformAiEngineView {
  engine: PlatformAiEngineName;
  label: string;
  baseUrl: string | null;
  model: string | null;
  isEnabled: boolean;
  priority: number;
  creditPer1kToken: number;
  health: string;
  unhealthyUntil: string | null;
  lastError: string | null;
  hasApiKey: boolean;
  apiKeyMask: string | null;
}

/** Masked, owner-facing view of all engines (never leaks the key). */
export async function getEnginesView(): Promise<PlatformAiEngineView[]> {
  const rows = await getEngines();
  return rows.filter((r) => isEngineName(r.engine)).map((r) => {
    const engine = r.engine as PlatformAiEngineName;
    let apiKeyMask: string | null = null;
    if (r.apiKeyEnc) {
      try {
        apiKeyMask = maskKey(decryptString(r.apiKeyEnc));
      } catch {
        apiKeyMask = "••••";
      }
    }
    return {
      engine,
      label: ENGINE_DEFAULTS[engine].label,
      baseUrl: r.baseUrl,
      model: r.model,
      isEnabled: r.isEnabled,
      priority: r.priority,
      creditPer1kToken: r.creditPer1kToken,
      health: r.health,
      unhealthyUntil: r.unhealthyUntil?.toISOString() ?? null,
      lastError: r.lastError,
      hasApiKey: !!r.apiKeyEnc,
      apiKeyMask,
    };
  });
}

export interface UpdateEngineInput {
  baseUrl?: string | null;
  model?: string | null;
  /** undefined = keep stored key; "" = clear; value = (re)encrypt. */
  apiKey?: string | null;
  isEnabled?: boolean;
  creditPer1kToken?: number;
}

/** Upsert one engine's credentials/config (priority is set via reorderEngines). */
export async function updateEngine(
  engine: string,
  input: UpdateEngineInput,
  now: Date = new Date(),
): Promise<PlatformAiEngineView> {
  if (!isEngineName(engine)) throw new PlatformAiEngineError(`Engine tidak dikenal: ${engine}`);

  let baseUrl: string | null = null;
  const rawBase = input.baseUrl?.trim();
  if (rawBase) {
    const v = validateBaseUrl(rawBase);
    if (!v.ok) throw new PlatformAiEngineError(v.reason);
    baseUrl = v.url;
  }

  const set: Partial<typeof platformAiEngineTable.$inferInsert> = { updatedAt: now };
  if (input.baseUrl !== undefined) set.baseUrl = baseUrl;
  if (input.model !== undefined) set.model = input.model?.trim() || null;
  if (input.isEnabled !== undefined) set.isEnabled = input.isEnabled;
  if (input.creditPer1kToken != null) set.creditPer1kToken = input.creditPer1kToken;
  if (input.apiKey !== undefined) set.apiKeyEnc = input.apiKey ? encryptString(input.apiKey) : null;

  await db.update(platformAiEngineTable).set(set).where(eq(platformAiEngineTable.engine, engine));
  const view = await getEnginesView();
  return view.find((v) => v.engine === engine)!;
}

/**
 * Set the full priority order (e.g. ['deepseek','gemini','openai','anthropic']).
 * Done in two passes inside a transaction (offset then final) so the unique
 * priority index never collides mid-update.
 */
export async function reorderEngines(order: string[]): Promise<PlatformAiEngineView[]> {
  const valid = order.filter(isEngineName);
  if (valid.length !== PLATFORM_AI_ENGINES.length || new Set(valid).size !== valid.length) {
    throw new PlatformAiEngineError("Urutan harus memuat keempat engine tepat sekali.");
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    // Pass 1: park priorities out of the 1..4 range to dodge the unique index.
    await tx
      .update(platformAiEngineTable)
      .set({ priority: 100 })
      .where(inArray(platformAiEngineTable.engine, valid));
    // Pass 2: assign final 1..4.
    for (let i = 0; i < valid.length; i++) {
      await tx
        .update(platformAiEngineTable)
        .set({ priority: i + 1, updatedAt: now })
        .where(eq(platformAiEngineTable.engine, valid[i]!));
    }
  });
  return getEnginesView();
}

// --- auto-failback re-probe (SPEC BAGIAN 11/16 step 11) --------------------

/**
 * Actively re-probe engines that are tripped (health='unhealthy') and whose
 * circuit-breaker window has expired: if the engine answers, mark it healthy
 * NOW (so the next real call rides the recovered engine without first failing),
 * and notify the owner of the failback. If it still fails, re-arm the breaker.
 * Returns the number of engines recovered. Never throws.
 *
 * This makes failback active rather than merely passive (the window simply
 * expiring) — a recovered higher-priority engine is restored before a customer
 * message would otherwise hit it cold.
 */
export async function reprobeUnhealthyEngines(now: Date = new Date()): Promise<number> {
  try {
    const cfg = await getPlatformAiConfig();
    if (!cfg.isActive || !cfg.autoFailback) return 0;

    const rows = await db
      .select()
      .from(platformAiEngineTable)
      .where(and(eq(platformAiEngineTable.health, "unhealthy"), isNotNull(platformAiEngineTable.apiKeyEnc)));

    // Only re-probe once the breaker window has expired (don't hammer a provider
    // that's still in its cool-down).
    const due = rows.filter(
      (r) => r.isEnabled && (!r.unhealthyUntil || r.unhealthyUntil.getTime() <= now.getTime()),
    );
    if (due.length === 0) return 0;

    let recovered = 0;
    for (const r of due) {
      const result = await testEngineConnection(r.engine, {});
      if (result.ok) {
        await markHealthy(r.engine, now);
        recovered++;
        void notifyOwnerFailback(r.engine);
      } else {
        // Still down → re-arm the breaker for another window.
        await markUnhealthy(r.engine, cfg.unhealthyMinutes, new Error(result.message), now);
      }
    }
    return recovered;
  } catch (err) {
    logger.error({ err }, "reprobeUnhealthyEngines failed");
    return 0;
  }
}

let reprobeStarted = false;

/** Start the periodic auto-failback re-probe (every minute). Idempotent. */
export function startEngineReprobeScheduler(): void {
  if (reprobeStarted) return;
  reprobeStarted = true;
  const tick = async () => {
    const n = await reprobeUnhealthyEngines();
    if (n > 0) logger.info({ recovered: n }, "platform AI engines recovered (auto-failback)");
  };
  setInterval(() => void tick(), 60_000);
  logger.info("platform AI engine re-probe scheduler started");
}

/** Live connectivity check for one engine. Never throws. */
export async function testEngineConnection(
  engine: string,
  input: { apiKey?: string | null; baseUrl?: string | null; model?: string | null },
): Promise<{ ok: boolean; message: string }> {
  try {
    if (!isEngineName(engine)) return { ok: false, message: "Engine tidak dikenal." };
    const defaults = ENGINE_DEFAULTS[engine];

    let apiKey = input.apiKey?.trim() || "";
    if (!apiKey) {
      const [row] = await db.select().from(platformAiEngineTable).where(eq(platformAiEngineTable.engine, engine)).limit(1);
      if (row?.apiKeyEnc) {
        try {
          apiKey = decryptString(row.apiKeyEnc);
        } catch {
          /* fall through */
        }
      }
    }
    if (!apiKey) return { ok: false, message: "API key belum diisi." };

    let baseURL = defaults.baseUrl;
    const rawBase = input.baseUrl?.trim();
    if (rawBase) {
      const v = validateBaseUrl(rawBase);
      if (!v.ok) return { ok: false, message: v.reason };
      baseURL = v.url;
    }
    const model = input.model?.trim() || defaults.defaultModel;
    const client = createOpenAiClient({ apiKey, baseURL });
    const resp = await client.chat.completions.create({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    const ok = Array.isArray(resp.choices) && resp.choices.length > 0;
    return ok
      ? { ok: true, message: `Koneksi berhasil ke ${defaults.label} (${model}).` }
      : { ok: false, message: "Mesin tidak mengembalikan respons yang valid." };
  } catch (err: unknown) {
    const e = err as { message?: string; error?: { message?: string } };
    return { ok: false, message: e?.error?.message || e?.message || "Gagal terhubung ke mesin AI." };
  } finally {
    logger.debug({ engine }, "platform engine test connection");
  }
}
