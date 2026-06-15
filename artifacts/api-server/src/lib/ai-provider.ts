import { eq } from "drizzle-orm";
import { db, aiProviderConfigTable, type AiProviderConfig } from "@workspace/db";
import { openai, createOpenAiClient } from "@workspace/integrations-openai-ai-server";
import { decryptString } from "./crypto";
import { resolveOwnerUserId } from "./seed";
import { resolvePlatformEngine, getPlatformAiConfig, type PlatformEngine } from "./platform-ai-config";
import { getEnabledEnginesByPriority } from "./platform-ai-engine";
import { createFailoverClient } from "./ai-failover";

// Full centralization (owner's decision): tenants do NOT use their own BYOK key
// — every tenant rides the centralized platform engine (precedence #2 below).
// Default false. Set POLICY_ALLOW_TENANT_BYOK=true only to re-enable per-tenant
// BYOK as an escape hatch.
const POLICY_ALLOW_TENANT_BYOK = process.env["POLICY_ALLOW_TENANT_BYOK"] === "true";

// Derive the client type from the lib factory so api-server never needs a
// direct dependency on the `openai` package (it stays transitive).
type AiClient = ReturnType<typeof createOpenAiClient>;

// The model used when a tenant rides Replit's managed integration. Kept here so
// the "replit" default lives in exactly one place.
export const DEFAULT_REPLIT_MODEL = "gpt-4o-mini";

export const AI_PROVIDERS = ["openai", "gemini", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_MODES = ["replit", "byok"] as const;
export type AiMode = (typeof AI_MODES)[number];

// Per-provider OpenAI-compatible defaults. OpenAI uses the SDK default base URL
// (undefined). Gemini and OpenRouter expose OpenAI-compatible endpoints.
export const PROVIDER_DEFAULTS: Record<
  AiProvider,
  { baseUrl?: string; defaultModel: string; label: string }
> = {
  openai: { baseUrl: undefined, defaultModel: "gpt-4o-mini", label: "OpenAI" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.0-flash",
    label: "Google Gemini",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    label: "OpenRouter",
  },
};

function asProvider(v: string | null | undefined): AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(v ?? "")
    ? (v as AiProvider)
    : "openai";
}

// SSRF guard for tenant-supplied base URLs. A super admin could otherwise point
// the OpenAI-compatible client at internal services or the cloud metadata
// endpoint, turning an outbound completion call into a server-side request to
// the private network. We require https and reject loopback / private /
// link-local / metadata hosts (literal IPs and obvious hostnames). Returns a
// human-readable reason on rejection.
export function validateBaseUrl(
  raw: string
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Base URL tidak valid." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Base URL harus memakai https://." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Hostname-based blocks.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return { ok: false, reason: "Base URL tidak boleh mengarah ke host internal." };
  }
  // IPv6 loopback / link-local / unique-local.
  if (host === "::1" || host === "::" || /^f[cde]/.test(host) || host.startsWith("fe80")) {
    return { ok: false, reason: "Base URL tidak boleh mengarah ke alamat internal." };
  }
  // IPv4 literal checks.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map((n) => Number(n));
    if (o.some((n) => n > 255)) {
      return { ok: false, reason: "Base URL tidak valid." };
    }
    const [a, b] = o;
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local + metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127); // CGNAT
    if (isPrivate) {
      return { ok: false, reason: "Base URL tidak boleh mengarah ke alamat internal." };
    }
  }
  return { ok: true, url: parsed.toString() };
}

// Read the tenant's config row (owner-scoped). Returns null when the tenant has
// never configured AI — callers treat that identically to mode = "replit".
export async function getAiProviderConfig(
  userId: number
): Promise<AiProviderConfig | null> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const [row] = await db
    .select()
    .from(aiProviderConfigTable)
    .where(eq(aiProviderConfigTable.ownerUserId, ownerUserId))
    .limit(1);
  return row ?? null;
}

// What `resolveAiClient` hands back. `provider`/`ownerUserId` are returned
// (not just `client`/`model`) so the call site can attribute token usage to the
// tenant owner without re-resolving — "replit" is the managed default, else the
// BYOK provider key.
export interface ResolvedAiClient {
  client: AiClient;
  model: string;
  provider: "replit" | "platform" | AiProvider | PlatformEngine;
  ownerUserId: number;
}

// Resolve the AI client + model to use for a tenant. Precedence:
//   1) tenant BYOK key — only when POLICY_ALLOW_TENANT_BYOK is on
//   2) the centralized PLATFORM engine (owner's credentials) — when active
//   3) the managed Replit integration (legacy fallback — unchanged)
export async function resolveAiClient(
  userId: number
): Promise<ResolvedAiClient> {
  const ownerUserId = await resolveOwnerUserId(userId);

  // 1) Tenant BYOK (policy-gated).
  if (POLICY_ALLOW_TENANT_BYOK) {
    const cfg = await getAiProviderConfig(ownerUserId);
    if (cfg && cfg.mode === "byok" && cfg.apiKeyEnc) {
      const provider = asProvider(cfg.provider);
      const defaults = PROVIDER_DEFAULTS[provider];
      const apiKey = decryptString(cfg.apiKeyEnc);
      // Defense-in-depth: ignore a stored base URL that fails the SSRF guard.
      let baseURL = defaults.baseUrl;
      const stored = cfg.baseUrl?.trim();
      if (stored) {
        const v = validateBaseUrl(stored);
        baseURL = v.ok ? v.url : defaults.baseUrl;
      }
      const client = createOpenAiClient({ apiKey, baseURL });
      const model = cfg.model?.trim() || defaults.defaultModel;
      return { client, model, provider, ownerUserId };
    }
  }

  // 2) Centralized platform engine with 4-engine priority failover (SPEC). When
  // the platform is active AND at least one engine is enabled, return the
  // transparent failover client — its create() runs the prepaid gate +
  // worst-case reserve (flag-gated) and the #1→#4 failover chain, attaching the
  // serving engine to the response so recordAiUsage settles + records it.
  const cfg = await getPlatformAiConfig();
  if (cfg.isActive) {
    const enabled = await getEnabledEnginesByPriority();
    if (enabled.length > 0) {
      return {
        client: createFailoverClient(ownerUserId),
        model: "auto", // chosen per-engine inside the failover client
        provider: "platform",
        ownerUserId,
      };
    }
  }

  // 2-legacy) Old single-engine platform config (DEPRECATED — kept so an owner
  // who configured the pre-failover engine keeps working until they enable the
  // 4 engines). No credit accounting on this path.
  const platform = await resolvePlatformEngine();
  if (platform) {
    return { client: platform.client, model: platform.model, provider: platform.engine, ownerUserId };
  }

  // 3) Managed Replit default.
  return {
    client: openai,
    model: DEFAULT_REPLIT_MODEL,
    provider: "replit",
    ownerUserId,
  };
}

// Live connectivity check: a tiny chat completion against the given provider.
// Used by the "Test koneksi" button before the user commits a config. Returns a
// human-readable message either way and never throws.
export async function testAiConnection(opts: {
  provider: AiProvider;
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const defaults = PROVIDER_DEFAULTS[opts.provider];
    const baseURL = opts.baseUrl?.trim() || defaults.baseUrl;
    const model = opts.model?.trim() || defaults.defaultModel;
    const client = createOpenAiClient({ apiKey: opts.apiKey, baseURL });
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
    const ok = Array.isArray(resp.choices) && resp.choices.length > 0;
    return ok
      ? { ok: true, message: `Koneksi berhasil ke ${defaults.label} (${model}).` }
      : { ok: false, message: "Provider tidak mengembalikan respons yang valid." };
  } catch (err: unknown) {
    const e = err as {
      status?: number;
      message?: string;
      error?: { message?: string };
    };
    const detail =
      e?.error?.message || e?.message || "Gagal terhubung ke provider.";
    return { ok: false, message: detail };
  }
}
