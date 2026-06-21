import { desc, eq } from "drizzle-orm";
import {
  db,
  chatMessagesTable,
  type OpportunityRow,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { getOrCreateTenantSettings } from "./settings-store";
import { buildFollowupSystemPrompt } from "./followup-prompt";
import { logger } from "./logger";

// ===========================================================================
// AI Sales Assistant — Auto Follow-Up message generator.
//
// Drafts ONE personalized follow-up nudge for an opportunity that has gone
// silent (waiting on the customer). Unlike generateAiReply (which answers a
// customer's last message), this is a PROACTIVE re-engagement touch: warm,
// short, references the deal context (contact name, products of interest, the
// pipeline stage, recent history) and ends with a gentle question to restart
// the conversation. Token usage is attributed to the tenant OWNER, mirroring
// every other AI call site. Best-effort: returns null on any failure so the
// engine simply skips this touch (it will be retried next sweep) rather than
// crashing the whole follow-up batch.
// ===========================================================================

export interface GeneratedFollowUp {
  text: string;
  provider: string;
  model: string;
}

// How many trailing messages to feed the model as conversation context.
const HISTORY_LIMIT = 10;

// Draft a follow-up message for one opportunity. `ownerUserId` is the tenant
// owner (usage attribution + tenant-wide AI settings); `userId` is the channel
// owner used to resolve the BYOK client (resolveAiClient resolves to the same
// owner internally). Returns null when generation fails or yields empty text.
export async function generateFollowUpMessage(opts: {
  opportunity: OpportunityRow;
  sequence: number;
}): Promise<GeneratedFollowUp | null> {
  const { opportunity, sequence } = opts;
  try {
    const ownerUserId = opportunity.ownerUserId;

    // Tenant-wide brand voice / persona (Lapis A), reused so the follow-up
    // sounds like the same business the customer was already talking to.
    const tenant = await getOrCreateTenantSettings(ownerUserId);

    // Recent conversation, oldest → newest, so the model can match the thread.
    const recentMessages = (
      await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatId, opportunity.chatId))
        .orderBy(desc(chatMessagesTable.id))
        .limit(HISTORY_LIMIT)
    ).reverse();

    const recentText = recentMessages
      .map(
        (m) =>
          `${m.direction === "outbound" ? "Bisnis" : "Pelanggan"}: ${(m.content ?? "").trim() || "[pesan media]"}`
      )
      .join("\n");

    // 3-lapis (lib/followup-prompt.ts): persona (Lapis A) + follow-up task with
    // conversation anchor (Lapis B) + locked guardrails (Lapis C). Identical
    // assembly to the ai-pipeline follow-up generator so the two never diverge.
    const systemPrompt = buildFollowupSystemPrompt(tenant.systemPrompt, {
      followupNumber: sequence,
      lastOpenPoint: opportunity.lastOpenPoint,
      stalledReason: opportunity.stalledReason,
      productInterest:
        opportunity.productInterest.length > 0
          ? opportunity.productInterest.join(", ")
          : null,
      aiNotes: opportunity.aiNotes,
      contactName: opportunity.contactName,
      recentMessages: recentText,
    });

    const { client, model, provider, ownerUserId: resolvedOwner } =
      await resolveAiClient(ownerUserId);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            "Tulis pesan follow-up sekarang sesuai instruksi di atas. Keluarkan hanya isi pesannya.",
        },
      ],
      max_tokens: 400,
      temperature: 0.7,
    });

    void recordAiUsage({
      ownerUserId: resolvedOwner,
      channelId: opportunity.channelId,
      provider,
      model,
      usage: response.usage,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    return { text, provider, model };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, opportunityId: opportunity.id },
      "follow-up message generation failed"
    );
    return null;
  }
}
