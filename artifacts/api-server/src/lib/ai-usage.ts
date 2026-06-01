import { db, aiUsageEventsTable } from "@workspace/db";
import { logger } from "./logger";

// Token usage as returned by the OpenAI-compatible client. All three providers
// (openai/gemini/openrouter) plus the managed Replit default expose this shape
// on `response.usage`, so capture is uniform.
export interface CompletionUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

function toInt(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Persist one usage event, attributed to the tenant OWNER. Best-effort: never
// throws and never blocks the reply — a failed usage write must not turn into a
// failed customer reply, so we swallow + log instead of propagating.
export async function recordAiUsage(opts: {
  ownerUserId: number;
  channelId: number | null;
  provider: string;
  model: string;
  usage: CompletionUsage | null | undefined;
}): Promise<void> {
  try {
    if (!opts.usage) return;
    const promptTokens = toInt(opts.usage.prompt_tokens);
    const completionTokens = toInt(opts.usage.completion_tokens);
    const totalTokens =
      toInt(opts.usage.total_tokens) || promptTokens + completionTokens;
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
      return;
    }
    await db.insert(aiUsageEventsTable).values({
      userId: opts.ownerUserId,
      channelId: opts.channelId,
      provider: opts.provider,
      model: opts.model,
      promptTokens,
      completionTokens,
      totalTokens,
    });
  } catch (err) {
    logger.error({ err }, "recordAiUsage failed");
  }
}
