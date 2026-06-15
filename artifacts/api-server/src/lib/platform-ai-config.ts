import { eq } from "drizzle-orm";
import { db, platformAiConfigTable, type PlatformAiConfigRow } from "@workspace/db";
import { createOpenAiClient } from "@workspace/integrations-openai-ai-server";
import { encryptString, decryptString } from "./crypto";
import { validateBaseUrl } from "./ai-provider";
import { logger } from "./logger";

// ===========================================================================
// Platform AI engine — the single AI engine all tenants ride, configured by the
// platform owner with the owner's own credentials. Both engines are reached
// through their OpenAI-compatible endpoints so the rest of the stack keeps one
// client shape (createOpenAiClient). The API key is AES-256-GCM at rest and is
// NEVER returned in plaintext — reads are masked.
// ===========================================================================

export const PLATFORM_ENGINES = ["anthropic", "gemini"] as const;
export type PlatformEngine = (typeof PLATFORM_ENGINES)[number];

export const ENGINE_DEFAULTS: Record<PlatformEngine, { baseUrl: string; defaultModel: string; label: string }> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1/",
    defaultModel: "claude-sonnet-4-6",
    label: "Claude (Anthropic)",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
    label: "Google Gemini",
  },
};

function asEngine(v: string | null | undefined): PlatformEngine {
  return (PLATFORM_ENGINES as readonly string[]).includes(v ?? "") ? (v as PlatformEngine) : "anthropic";
}

/** Read the singleton row (id=1), self-healing if somehow missing. */
export async function getPlatformAiConfig(): Promise<PlatformAiConfigRow> {
  const [row] = await db.select().from(platformAiConfigTable).where(eq(platformAiConfigTable.id, 1)).limit(1);
  if (row) return row;
  const [created] = await db.insert(platformAiConfigTable).values({ id: 1 }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(platformAiConfigTable).where(eq(platformAiConfigTable.id, 1)).limit(1);
  return again;
}

/** Mask a decrypted key as `sk-ant-…AB12` (prefix + last 4). */
function maskKey(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}

export interface PlatformAiConfigView {
  engine: PlatformEngine;
  model: string | null;
  baseUrl: string | null;
  isActive: boolean;
  markupBps: number;
  creditPer1kTokenAnthropic: number;
  creditPer1kTokenGemini: number;
  minStopCredits: number;
  // Failover knobs (SPEC BAGIAN 4) — global, apply across the 4-engine chain.
  autoFailover: boolean;
  autoFailback: boolean;
  unhealthyMinutes: number;
  bothFailedRetry: boolean;
  hasApiKey: boolean;
  apiKeyMask: string | null;
  updatedAt: string;
}

/** Owner-facing view: never includes the ciphertext or plaintext key. */
export async function getPlatformAiConfigView(): Promise<PlatformAiConfigView> {
  const c = await getPlatformAiConfig();
  let apiKeyMask: string | null = null;
  if (c.apiKeyEnc) {
    try {
      apiKeyMask = maskKey(decryptString(c.apiKeyEnc));
    } catch {
      apiKeyMask = "••••"; // key present but undecryptable (e.g. SESSION_SECRET rotated)
    }
  }
  return {
    engine: asEngine(c.engine),
    model: c.model,
    baseUrl: c.baseUrl,
    isActive: c.isActive,
    markupBps: c.markupBps,
    creditPer1kTokenAnthropic: c.creditPer1kTokenAnthropic,
    creditPer1kTokenGemini: c.creditPer1kTokenGemini,
    minStopCredits: c.minStopCredits,
    autoFailover: c.autoFailover,
    autoFailback: c.autoFailback,
    unhealthyMinutes: c.unhealthyMinutes,
    bothFailedRetry: c.bothFailedRetry,
    hasApiKey: !!c.apiKeyEnc,
    apiKeyMask,
    updatedAt: c.updatedAt.toISOString(),
  };
}

export interface UpdatePlatformAiInput {
  /** DEPRECATED single-engine field — only touched when provided. */
  engine?: PlatformEngine;
  model?: string | null;
  baseUrl?: string | null;
  /** Omit (undefined) to keep the existing key; "" clears it. */
  apiKey?: string | null;
  isActive?: boolean;
  markupBps?: number;
  creditPer1kTokenAnthropic?: number;
  creditPer1kTokenGemini?: number;
  minStopCredits?: number;
  // Failover knobs (SPEC BAGIAN 4).
  autoFailover?: boolean;
  autoFailback?: boolean;
  unhealthyMinutes?: number;
  bothFailedRetry?: boolean;
}

/**
 * Update the singleton's GLOBAL knobs (markup, min-stop, failover, is_active).
 * Per-engine credentials now live in platform_ai_engine (see updateEngine);
 * the deprecated single-engine fields here are only touched when `engine` is
 * provided, for backward compatibility. apiKey omitted → keep; "" → clear.
 * Base URL is SSRF-validated when present. Returns the masked view.
 */
export async function updatePlatformAiConfig(
  input: UpdatePlatformAiInput,
  updatedBy: number | null,
): Promise<PlatformAiConfigView> {
  // Ensure the row exists before a partial UPDATE.
  await getPlatformAiConfig();

  const set: Partial<typeof platformAiConfigTable.$inferInsert> = {
    updatedBy,
    updatedAt: new Date(),
  };
  if (input.isActive !== undefined) set.isActive = input.isActive;
  if (input.markupBps != null) set.markupBps = input.markupBps;
  if (input.creditPer1kTokenAnthropic != null) set.creditPer1kTokenAnthropic = input.creditPer1kTokenAnthropic;
  if (input.creditPer1kTokenGemini != null) set.creditPer1kTokenGemini = input.creditPer1kTokenGemini;
  if (input.minStopCredits != null) set.minStopCredits = input.minStopCredits;
  if (input.autoFailover !== undefined) set.autoFailover = input.autoFailover;
  if (input.autoFailback !== undefined) set.autoFailback = input.autoFailback;
  if (input.unhealthyMinutes != null) set.unhealthyMinutes = input.unhealthyMinutes;
  if (input.bothFailedRetry !== undefined) set.bothFailedRetry = input.bothFailedRetry;

  // DEPRECATED single-engine fields: only touched when an engine is explicitly
  // passed (the old 2-engine UI). The new 4-block UI never sends these.
  if (input.engine !== undefined) {
    set.engine = asEngine(input.engine);
    set.model = input.model?.trim() || null;
    let baseUrl: string | null = null;
    const rawBase = input.baseUrl?.trim();
    if (rawBase) {
      const v = validateBaseUrl(rawBase);
      if (!v.ok) throw new PlatformAiConfigError(v.reason);
      baseUrl = v.url;
    }
    set.baseUrl = baseUrl;
    // apiKey: undefined = keep; "" = clear; value = (re)encrypt.
    if (input.apiKey !== undefined) {
      set.apiKeyEnc = input.apiKey ? encryptString(input.apiKey) : null;
    }
  }

  await db.update(platformAiConfigTable).set(set).where(eq(platformAiConfigTable.id, 1));

  return getPlatformAiConfigView();
}

export class PlatformAiConfigError extends Error {}

interface ResolvedPlatformEngine {
  client: ReturnType<typeof createOpenAiClient>;
  model: string;
  engine: PlatformEngine;
}

/**
 * Build the platform engine client from the stored config, or null when the
 * engine is inactive / has no key. Used by resolveAiClient as precedence #2.
 */
export async function resolvePlatformEngine(): Promise<ResolvedPlatformEngine | null> {
  const c = await getPlatformAiConfig();
  if (!c.isActive || !c.apiKeyEnc) return null;
  const engine = asEngine(c.engine);
  const defaults = ENGINE_DEFAULTS[engine];

  let apiKey: string;
  try {
    apiKey = decryptString(c.apiKeyEnc);
  } catch (err) {
    logger.error({ err }, "platform AI key decrypt failed; skipping platform engine");
    return null;
  }

  // Defense-in-depth: ignore a stored base URL that fails the SSRF guard.
  let baseURL = defaults.baseUrl;
  const stored = c.baseUrl?.trim();
  if (stored) {
    const v = validateBaseUrl(stored);
    baseURL = v.ok ? v.url : defaults.baseUrl;
  }

  const client = createOpenAiClient({ apiKey, baseURL });
  const model = c.model?.trim() || defaults.defaultModel;
  return { client, model, engine };
}

/** Live connectivity check used by the "Tes koneksi" button. Never throws. */
export async function testPlatformAiConnection(input: {
  engine: PlatformEngine;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const engine = asEngine(input.engine);
    const defaults = ENGINE_DEFAULTS[engine];

    // Use the provided key, or fall back to the stored one (lets the owner test
    // without re-typing the key).
    let apiKey = input.apiKey?.trim() || "";
    if (!apiKey) {
      const c = await getPlatformAiConfig();
      if (c.apiKeyEnc) {
        try {
          apiKey = decryptString(c.apiKeyEnc);
        } catch {
          /* fall through to the empty-key error below */
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
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
    const ok = Array.isArray(resp.choices) && resp.choices.length > 0;
    return ok
      ? { ok: true, message: `Koneksi berhasil ke ${defaults.label} (${model}).` }
      : { ok: false, message: "Mesin tidak mengembalikan respons yang valid." };
  } catch (err: unknown) {
    const e = err as { message?: string; error?: { message?: string } };
    return { ok: false, message: e?.error?.message || e?.message || "Gagal terhubung ke mesin AI." };
  }
}
