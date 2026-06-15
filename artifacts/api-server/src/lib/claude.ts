import Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "./ai-usage";
import { logger } from "./logger";

// ===========================================================================
// Claude (Anthropic) client — dedicated to AI-insight generation for the
// Laporan & Jadwal feature. This is an intentional exception to the codebase's
// "all AI goes through resolveAiClient" rule (requested for richer narrative
// insights); usage is still recorded against the tenant owner.
// ===========================================================================

export const CLAUDE_INSIGHT_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function isClaudeConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY belum dikonfigurasi");
    client = new Anthropic({ apiKey });
  }
  return client;
}

export interface ClaudeJsonOptions {
  ownerUserId: number;
  system: string;
  user: string;
  maxTokens: number;
  /** Total wall-clock budget; one retry on transient failure. */
  timeoutMs?: number;
}

/**
 * Call Claude expecting a JSON object back. Parses the first JSON object in the
 * response, records token usage against the owner, and retries once on failure.
 * Returns null when Claude is unconfigured or both attempts fail.
 */
export async function callClaudeJson<T = Record<string, unknown>>(opts: ClaudeJsonOptions): Promise<T | null> {
  if (!isClaudeConfigured()) return null;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = await getClient().messages.create(
        {
          model: CLAUDE_INSIGHT_MODEL,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
        },
        { timeout: timeoutMs },
      );

      // Attribute token usage to the owner (member usage rolls up).
      void recordAiUsage({
        ownerUserId: opts.ownerUserId,
        channelId: null,
        provider: "anthropic",
        model: CLAUDE_INSIGHT_MODEL,
        usage: {
          prompt_tokens: msg.usage.input_tokens,
          completion_tokens: msg.usage.output_tokens,
          total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
        },
      });

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parsed = extractJson<T>(text);
      if (parsed) return parsed;
      logger.warn({ attempt }, "claude insight: no JSON in response");
    } catch (err) {
      logger.error({ err, attempt }, "claude insight call failed");
    }
  }
  return null;
}

function extractJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
