import { db, aiUsageEventsTable } from "@workspace/db";
import { logger } from "./logger";
import { getPlatformAiConfig } from "./platform-ai-config";
import { getEngineCreditRate } from "./platform-ai-engine";
import { tokensToCredits } from "./credit-math";
import { settleCall } from "./credit-wallet";
import { maybeNotifyLowBalance } from "./credit-notify";
import { readCreditMeta } from "./ai-call-meta";
import { consumeBoosterOverflow } from "./token-boosters";

// Prepaid AI-credit wallet gate. Default OFF → zero behavior change (no charge,
// creditsCharged stays 0). Flip on only once tenant wallets are funded.
const PREPAID_CREDITS_ENABLED = process.env["POLICY_PREPAID_CREDITS"] === "true";

// Convert a settled platform call's token usage into the credits to debit,
// using the SERVING engine's per-1k rate + the platform markup (SPEC BAGIAN 8:
// "potong tarif pelayan"). Settlement is idempotent on the reservation callId.
// Best-effort: never throws.
async function chargePlatformCredits(
  ownerUserId: number,
  engine: string,
  totalTokens: number,
  callId: string,
): Promise<number> {
  try {
    const cfg = await getPlatformAiConfig();
    const rate = await getEngineCreditRate(engine);
    const credits = tokensToCredits(totalTokens, rate, cfg.markupBps);
    if (credits <= 0) return 0;
    const res = await settleCall({ ownerUserId, callId, actualCredits: credits });
    if (res.shortfall > 0) {
      logger.warn(
        { ownerUserId, callId, engine, shortfall: res.shortfall },
        "credit wallet went short on settle (concurrent overspend)",
      );
    }
    // Fire low-balance threshold notifications after the debit (best-effort,
    // never throws; skips re-settles which don't change the balance).
    if (!res.alreadySettled) void maybeNotifyLowBalance(ownerUserId);
    return res.charged;
  } catch (err) {
    logger.error({ err, ownerUserId, engine }, "credit settle failed");
    return 0;
  }
}

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

    // The failover client attaches the SERVING engine + reservation id to the
    // usage object (ai-call-meta). When present, debit the prepaid wallet at
    // that engine's rate (flag-gated) and record the engine on the event. The
    // charge is settled before the usage row so creditsCharged is atomic.
    const meta = readCreditMeta(opts.usage);
    const engine = meta?.engine ?? null;
    let creditsCharged = 0;
    if (PREPAID_CREDITS_ENABLED && meta?.engine && meta.creditCallId) {
      creditsCharged = await chargePlatformCredits(
        opts.ownerUserId,
        meta.engine,
        totalTokens,
        meta.creditCallId,
      );
    }

    await db.insert(aiUsageEventsTable).values({
      userId: opts.ownerUserId,
      channelId: opts.channelId,
      provider: opts.provider,
      engine,
      model: opts.model,
      promptTokens,
      completionTokens,
      totalTokens,
      creditsCharged,
    });

    // Two-bucket quota (LOCKED spec B3): grant is computed live, but any spend
    // beyond the monthly grant must DECREMENT paid boosters (they carry across
    // periods, so the counter has to persist). Best-effort, never throws; cheap
    // no-op for the common case of an owner with no boosters.
    void consumeBoosterOverflow(opts.ownerUserId, totalTokens);
  } catch (err) {
    logger.error({ err }, "recordAiUsage failed");
  }
}
