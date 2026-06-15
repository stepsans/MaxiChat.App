import { randomUUID } from "node:crypto";
import { createOpenAiClient } from "@workspace/integrations-openai-ai-server";
import { getPlatformAiConfig } from "./platform-ai-config";
import {
  getEnabledEnginesByPriority,
  buildEngineClient,
  markHealthy,
  markUnhealthy,
} from "./platform-ai-engine";
import { isFailoverEligible } from "./ai-error-classify";
import { notifyOwnerFailover, notifyOwnerAllDown, notifyOwnerFailback } from "./platform-ai-notify";
import { guardCredits, reserveForCall, releaseHold } from "./credit-wallet";
import { worstCaseEstimate, DEFAULT_MAX_OUTPUT_TOKENS } from "./credit-math";
import { attachCreditMeta } from "./ai-call-meta";
import type { PlatformAiEngineName } from "@workspace/db";
import { logger } from "./logger";

// Prepaid gate flag (same env as ai-provider/ai-usage). Failover itself is
// ALWAYS on for the platform engine; only the credit gate/reserve is flag-gated.
const PREPAID_CREDITS_ENABLED = process.env["POLICY_PREPAID_CREDITS"] === "true";

type AiClient = ReturnType<typeof createOpenAiClient>;

// ===========================================================================
// Priority failover chain (SPEC BAGIAN 5.2). Iterates the enabled engines by
// priority (#1→#4), skipping those inside their circuit-breaker window; on a
// failover-eligible failure it marks the engine unhealthy and moves on, and on
// success it marks the engine healthy (auto-failback basis). If the whole list
// fails and both_failed_retry is on, it retries the list once after a short
// delay before giving up with AI_ALL_ENGINES_DOWN.
//
// NOTE: tenant credit exhaustion is handled by the prepaid gate BEFORE this is
// called — it is never a reason to fail over.
// ===========================================================================

export class AllEnginesDownError extends Error {
  constructor() {
    super("AI_ALL_ENGINES_DOWN");
    this.name = "AllEnginesDownError";
  }
}

export class PlatformInactiveError extends Error {
  constructor() {
    super("PLATFORM_AI_INACTIVE");
    this.name = "PlatformInactiveError";
  }
}

// Loosely typed to avoid coupling to the OpenAI SDK request/response shapes.
type ChatParams = Record<string, unknown>;
type ChatResponse = { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };

export interface FailoverResult<R = ChatResponse> {
  res: R;
  engine: PlatformAiEngineName;
  model: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a chat completion across the engine failover chain. `buildRequest(model)`
 * returns the completion params for the engine's model (so the same logical
 * request is re-issued per engine). Throws PlatformInactiveError when the
 * platform engine is off (caller falls back to the managed default), or
 * AllEnginesDownError when every engine fails.
 */
export async function callAiWithFailover<R = ChatResponse>(
  ownerUserId: number,
  buildRequest: (model: string) => ChatParams,
  now: Date = new Date(),
): Promise<FailoverResult<R>> {
  const cfg = await getPlatformAiConfig();
  if (!cfg.isActive) throw new PlatformInactiveError();

  const all = await getEnabledEnginesByPriority();
  if (all.length === 0) throw new PlatformInactiveError();

  const nowMs = now.getTime();
  // Skip engines still inside their circuit-breaker window; if every engine is
  // tripped, try the full list anyway (better a long-shot than no reply).
  let list = all.filter((e) => !e.unhealthyUntil || e.unhealthyUntil.getTime() <= nowMs);
  if (list.length === 0) list = all;

  const attempt = async (): Promise<FailoverResult<R> | null> => {
    for (const e of list) {
      // An engine that was tripped/unknown before this call and now succeeds has
      // recovered → notify failback (auto-failback basis, SPEC BAGIAN 11.2).
      const wasUnhealthy = e.health === "unhealthy" || (!!e.unhealthyUntil && e.unhealthyUntil.getTime() > nowMs);
      try {
        const { client, model } = buildEngineClient(e);
        const res = (await client.chat.completions.create(buildRequest(model) as never)) as R;
        await markHealthy(e.engine);
        if (cfg.autoFailback && wasUnhealthy) void notifyOwnerFailback(e.engine);
        return { res, engine: e.engine as PlatformAiEngineName, model };
      } catch (err) {
        if (!cfg.autoFailover || !isFailoverEligible(err)) throw err;
        await markUnhealthy(e.engine, cfg.unhealthyMinutes, err);
        logger.warn({ ownerUserId, engine: e.engine, err }, "AI engine failed; failing over to next");
        void notifyOwnerFailover(e.engine, err); // best-effort; never blocks the next hop
      }
    }
    return null;
  };

  let out = await attempt();
  if (!out && cfg.bothFailedRetry) {
    await sleep(cfg.bothFailedRetryDelayMs);
    out = await attempt();
  }
  if (!out) {
    logger.error({ ownerUserId }, "all AI engines down; pausing AI replies");
    void notifyOwnerAllDown(); // best-effort; manual chat still works
    throw new AllEnginesDownError();
  }
  return out;
}

/** Rough token estimate from the request messages (chars/4) for the reserve. */
function estimateInputTokens(params: ChatParams): number {
  try {
    return Math.ceil(JSON.stringify(params["messages"] ?? "").length / 4);
  } catch {
    return 1000;
  }
}

/**
 * A drop-in OpenAI-compatible client for the platform path whose
 * `chat.completions.create` transparently runs the prepaid gate + worst-case
 * reservation (flag-gated) and the priority failover chain. The serving engine
 * + reservation id are attached to the response's `usage` so recordAiUsage can
 * settle the actual charge and record the engine — no call-site changes.
 *
 * Throws PlatformInactiveError when the platform engine is off (resolveAiClient
 * then falls back to the managed default), or InsufficientCreditsError when the
 * gate blocks the call.
 */
export function createFailoverClient(ownerUserId: number): AiClient {
  const create = async (params: ChatParams): Promise<ChatResponse> => {
    const cfg = await getPlatformAiConfig();

    if (!PREPAID_CREDITS_ENABLED) {
      // Failover only; no credit accounting.
      const { res, engine } = await callAiWithFailover(ownerUserId, (model) => ({ ...params, model }));
      attachCreditMeta(res.usage, { engine, creditCallId: null });
      return res;
    }

    // Prepaid gate + worst-case reservation, reconciled at settle (recordAiUsage).
    const enabled = await getEnabledEnginesByPriority();
    const maxOut = typeof params["max_tokens"] === "number" ? (params["max_tokens"] as number) : DEFAULT_MAX_OUTPUT_TOKENS;
    const reserve = worstCaseEstimate(
      estimateInputTokens(params),
      enabled.map((e) => ({ creditPer1kToken: e.creditPer1kToken })),
      cfg.markupBps,
      maxOut,
    );
    await guardCredits(ownerUserId, cfg.minStopCredits);
    const callId = randomUUID();
    await reserveForCall({ ownerUserId, callId, estimatedCredits: reserve, minStopCredits: cfg.minStopCredits });
    try {
      const { res, engine } = await callAiWithFailover(ownerUserId, (model) => ({ ...params, model }));
      if (res.usage) {
        attachCreditMeta(res.usage, { engine, creditCallId: callId });
      } else {
        // No usage reported → nothing to charge; free the reservation now.
        await releaseHold(callId);
      }
      return res;
    } catch (err) {
      await releaseHold(callId);
      throw err;
    }
  };

  // Only chat.completions.create is used by call sites; the rest of the OpenAI
  // surface is intentionally not proxied.
  return { chat: { completions: { create } } } as unknown as AiClient;
}
