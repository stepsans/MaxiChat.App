import { eq } from "drizzle-orm";
import { db, aiProviderConfigTable, type AiProviderConfig } from "@workspace/db";
import { openai, createOpenAiClient } from "@workspace/integrations-openai-ai-server";
import { decryptString } from "./crypto";
import { resolveOwnerUserId } from "./seed";

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

// Resolve the AI client + model to use for a tenant. Defaults to the managed
// Replit integration (no key required). Only when the tenant has explicitly
// chosen "byok" with a stored key do we build a client from their own key.
export async function resolveAiClient(
  userId: number
): Promise<{ client: AiClient; model: string }> {
  const cfg = await getAiProviderConfig(userId);
  if (!cfg || cfg.mode !== "byok" || !cfg.apiKeyEnc) {
    return { client: openai, model: DEFAULT_REPLIT_MODEL };
  }
  const provider = asProvider(cfg.provider);
  const defaults = PROVIDER_DEFAULTS[provider];
  const apiKey = decryptString(cfg.apiKeyEnc);
  // Defense-in-depth: ignore a stored base URL that fails the SSRF guard and
  // fall back to the provider default rather than issuing the request.
  let baseURL = defaults.baseUrl;
  const stored = cfg.baseUrl?.trim();
  if (stored) {
    const v = validateBaseUrl(stored);
    baseURL = v.ok ? v.url : defaults.baseUrl;
  }
  const client = createOpenAiClient({ apiKey, baseURL });
  const model = cfg.model?.trim() || defaults.defaultModel;
  return { client, model };
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
